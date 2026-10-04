import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http'
import { delay, of, throwError, timer, switchMap } from 'rxjs'
import { seedClaims } from './seed'
import { emptyLedger, effectiveBasis } from './ledger'
import type { ClaimCase, ConflictRecord, Payment, PaymentBasis, PaymentRequest, PaymentResult, Receipt, ReceiptRequest } from './models'

let claims = structuredClone(seedClaims)

const now = () => new Date().toLocaleString('zh-CN')

/** 依据会签结果生成支付依据：同一案件同一时刻只有一份已生效依据 */
function createBasis(item: ClaimCase, operator: string): PaymentBasis | null {
  const ledger = item.ledger ?? (item.ledger = emptyLedger())
  const allPassed = item.approvals.length > 0 && item.approvals.every((step) => step.status === '已通过')
  if (!allPassed) return null
  const prev = effectiveBasis(ledger)
  if (prev) {
    prev.status = '已失效'
    prev.invalidatedAt = now()
    prev.invalidatedReason = '新版本支付依据生效'
  }
  const basis: PaymentBasis = {
    id: `BASIS-${Date.now()}`,
    version: ledger.basis.length + 1,
    amount: item.reserve,
    status: '已生效',
    source: '多级会签结果',
    approvedBy: item.approvals.filter((step) => step.status === '已通过').map((step) => step.operator).filter(Boolean).join('、') || '会签',
    approvedAt: now(),
  }
  ledger.basis.unshift(basis)
  item.status = '待支付'
  item.audit.push({ id: `A-${Date.now()}`, at: '刚刚', operator, action: '支付依据生效', detail: `支付依据 V${basis.version} 生效，金额 ${basis.amount} 元` })
  return basis
}

/** 付款确认：同一支付号幂等；同一依据版本先到者生效，后到内容留冲突记录 */
function applyPayment(item: ClaimCase, body: PaymentRequest, operator: string): PaymentResult {
  const ledger = item.ledger ?? (item.ledger = emptyLedger())
  const existing = ledger.payments.find((p) => p.paymentNo === body.paymentNo)
  if (existing) return { applied: true, payment: existing, idempotent: true }

  const basis = effectiveBasis(ledger)
  if (!basis) return { applied: false, noBasis: true }

  if (ledger.payments.some((p) => p.basisVersion === basis.version)) {
    const conflict: ConflictRecord = {
      id: `CF-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: '付款冲突',
      paymentNo: body.paymentNo,
      basisVersion: basis.version,
      content: `${body.kind} ${body.amount} 元（${body.payee}），支付号 ${body.paymentNo}`,
      reason: `支付依据 V${basis.version} 已有生效付款，先到者已入账，后到内容留在冲突记录`,
      operator,
      createdAt: now(),
    }
    ledger.conflicts.unshift(conflict)
    return { applied: false, conflict }
  }

  const payment: Payment = {
    id: `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    paymentNo: body.paymentNo,
    basisVersion: basis.version,
    kind: body.kind,
    amount: body.amount,
    payee: body.payee,
    status: '已确认',
    operator,
    createdAt: now(),
  }
  ledger.payments.unshift(payment)
  item.paid = ledger.payments.reduce((sum, p) => sum + p.amount, 0)
  item.audit.push({ id: `A-${Date.now()}`, at: '刚刚', operator, action: '付款确认', detail: `${body.kind} ${body.amount} 元（${body.payee}），支付号 ${body.paymentNo}，依据 V${basis.version}` })
  return { applied: true, payment }
}

export const mockApiInterceptor: HttpInterceptorFn = (request, next) => {
  if (!request.url.startsWith('/api/')) return next(request)

  if (request.method === 'GET' && request.url === '/api/claims') {
    const query = request.params.get('query')?.toLowerCase() ?? ''
    const status = request.params.get('status') ?? ''
    const risk = request.params.get('risk') ?? ''
    const page = Number(request.params.get('page') ?? 1)
    const pageSize = Number(request.params.get('pageSize') ?? 10)
    const filtered = claims.filter(
      (item) =>
        (!query || `${item.id}${item.insured}${item.policyNo}`.toLowerCase().includes(query)) &&
        (!status || item.status === status) &&
        (!risk || item.riskLevel === risk),
    )
    const start = (page - 1) * pageSize
    return of(new HttpResponse({ status: 200, body: { items: filtered.slice(start, start + pageSize), total: filtered.length, page, pageSize } })).pipe(delay(220))
  }

  if (request.method === 'GET' && request.url.startsWith('/api/claims/')) {
    const id = request.url.split('/').pop()
    const item = claims.find((claim) => claim.id === id)
    return item ? of(new HttpResponse({ status: 200, body: item })).pipe(delay(120)) : throwError(() => new HttpErrorResponse({ status: 404 }))
  }

  if (request.method === 'POST' && request.url.endsWith('/quotes')) {
    const id = request.url.split('/').at(-2)
    const body = request.body as { itemId: string; amount: number; reason: string }
    const item = claims.find((claim) => claim.id === id)?.lossItems.find((loss) => loss.id === body.itemId)
    if (!item) return throwError(() => new HttpErrorResponse({ status: 404 }))
    item.repairQuotes.push({
      version: item.repairQuotes.length + 1,
      amount: body.amount,
      reason: body.reason,
      operator: '当前用户',
      createdAt: now(),
    })
    return of(new HttpResponse({ status: 201, body: item })).pipe(delay(180))
  }

  if (request.method === 'POST' && request.url.endsWith('/approvals')) {
    const id = request.url.split('/').at(-2)
    const body = request.body as { role: string; result: string; comment: string }
    const item = claims.find((claim) => claim.id === id)
    const step = item?.approvals.find((approval) => approval.role === body.role)
    if (!item || !step) return throwError(() => new HttpErrorResponse({ status: 404 }))
    step.status = body.result === '已通过' ? '已通过' : '已退回'
    step.operator = '当前用户'
    step.comment = body.comment
    step.completedAt = now()
    item.audit.push({ id: `A-${Date.now()}`, at: '刚刚', operator: '当前用户', action: `会签${step.status}`, detail: body.comment })
    if (body.result === '已通过' && item.approvals.every((approval) => approval.status === '已通过')) {
      createBasis(item, '当前用户')
    } else {
      item.status = body.result === '已通过' ? '审批中' : '退回补件'
    }
    return of(new HttpResponse({ status: 200, body: item })).pipe(delay(180))
  }

  if (request.method === 'POST' && request.url.endsWith('/basis')) {
    const id = request.url.split('/').at(-2)
    const item = claims.find((claim) => claim.id === id)
    if (!item) return throwError(() => new HttpErrorResponse({ status: 404 }))
    const basis = createBasis(item, '当前用户')
    if (!basis) {
      return of(new HttpResponse({ status: 400, body: { claim: item, result: { error: '会签未全部完成，暂不能生成支付依据' } } })).pipe(delay(120))
    }
    return of(new HttpResponse({ status: 201, body: { claim: item, result: { basis } } })).pipe(delay(150))
  }

  if (request.method === 'POST' && request.url.endsWith('/payments')) {
    const id = request.url.split('/').at(-2)
    const body = request.body as PaymentRequest
    const item = claims.find((claim) => claim.id === id)
    if (!item) return throwError(() => new HttpErrorResponse({ status: 404 }))
    const run = () => {
      const result = applyPayment(item, body, '当前用户')
      if (body.simulateFailure && result.applied) {
        return of(new HttpResponse({ status: 500, body: { claim: item, result: { ...result, failed: true } } }))
      }
      if (!result.applied && result.noBasis) {
        return of(new HttpResponse({ status: 409, body: { claim: item, result } }))
      }
      return of(new HttpResponse({ status: 200, body: { claim: item, result } }))
    }
    const jitter = body.concurrent ? 10 + Math.random() * 70 : 0
    return timer(jitter).pipe(switchMap(() => run()))
  }

  if (request.method === 'POST' && request.url.endsWith('/receipts')) {
    const id = request.url.split('/').at(-2)
    const body = request.body as ReceiptRequest
    const item = claims.find((claim) => claim.id === id)
    if (!item) return throwError(() => new HttpErrorResponse({ status: 404 }))
    const ledger = item.ledger ?? (item.ledger = emptyLedger())
    const existing = ledger.receipts.find((r) => r.receiptNo === body.receiptNo)
    if (existing) {
      return of(new HttpResponse({ status: 200, body: { claim: item, result: { receipt: existing } } })).pipe(delay(100))
    }
    const receipt: Receipt = {
      id: `RCT-${Date.now()}`,
      receiptNo: body.receiptNo,
      kind: body.kind,
      amount: body.amount,
      status: '在途',
      createdAt: now(),
    }
    ledger.receipts.unshift(receipt)
    item.audit.push({ id: `A-${Date.now()}`, at: '刚刚', operator: '当前用户', action: '回款登记', detail: `${body.kind} ${body.amount} 元，流水号 ${body.receiptNo}（在途）` })
    return of(new HttpResponse({ status: 201, body: { claim: item, result: { receipt } } })).pipe(delay(120))
  }

  if (request.method === 'POST' && request.url.endsWith('/arrive')) {
    const parts = request.url.split('/')
    const id = parts.at(-4)
    const receiptNo = decodeURIComponent(parts.at(-2) ?? '')
    const item = claims.find((claim) => claim.id === id)
    const receipt = item?.ledger?.receipts.find((r) => r.receiptNo === receiptNo)
    if (!item || !receipt) return throwError(() => new HttpErrorResponse({ status: 404 }))
    if (receipt.status === '已到账') {
      return of(new HttpResponse({ status: 200, body: { claim: item, result: { receipt } } })).pipe(delay(100))
    }
    receipt.status = '已到账'
    receipt.arrivedAt = now()
    item.audit.push({ id: `A-${Date.now()}`, at: '刚刚', operator: '当前用户', action: '回款到账', detail: `${receipt.kind} ${receipt.amount} 元已到账，冲减未结金额` })
    return of(new HttpResponse({ status: 200, body: { claim: item, result: { receipt } } })).pipe(delay(120))
  }

  if (request.method === 'POST' && request.url.endsWith('/reconciliation')) {
    const id = request.url.split('/').at(-2)
    const body = request.body as { difference: number; reason: string }
    const item = claims.find((claim) => claim.id === id)
    if (!item) return throwError(() => new HttpErrorResponse({ status: 404 }))
    const ledger = item.ledger ?? (item.ledger = emptyLedger())
    const basis = effectiveBasis(ledger)
    if (basis) {
      basis.status = '已失效'
      basis.invalidatedAt = now()
      basis.invalidatedReason = `对账差异 ${body.difference} 元：${body.reason}`
    }
    item.reserve = Math.max(0, item.reserve + body.difference)
    ledger.conflicts.unshift({
      id: `CF-${Date.now()}`,
      type: '对账差异',
      content: `对账差异 ${body.difference} 元（${body.reason}）`,
      reason: '对账差异导致原支付依据失效，准备金已重算，需重新生成支付依据',
      operator: '当前用户',
      createdAt: now(),
    })
    item.audit.push({ id: `A-${Date.now()}`, at: '刚刚', operator: '当前用户', action: '对账差异', detail: `差异 ${body.difference} 元，准备金重算为 ${item.reserve}，原支付依据失效` })
    return of(new HttpResponse({ status: 200, body: { claim: item } })).pipe(delay(150))
  }

  if (request.method === 'POST' && request.url.endsWith('/reserve')) {
    const id = request.url.split('/').at(-2)
    const body = request.body as { amount: number; reason: string }
    const item = claims.find((claim) => claim.id === id)
    if (!item) return throwError(() => new HttpErrorResponse({ status: 404 }))
    const ledger = item.ledger ?? (item.ledger = emptyLedger())
    const oldAmount = item.reserve
    const basis = effectiveBasis(ledger)
    if (basis) {
      basis.status = '已失效'
      basis.invalidatedAt = now()
      basis.invalidatedReason = `金额改动：${oldAmount} → ${body.amount}（${body.reason}）`
    }
    item.reserve = body.amount
    ledger.conflicts.unshift({
      id: `CF-${Date.now()}`,
      type: '金额改动',
      content: `准备金金额改动 ${oldAmount} → ${body.amount} 元（${body.reason}）`,
      reason: '金额改动导致原支付依据失效，准备金已重算，需重新生成支付依据',
      operator: '当前用户',
      createdAt: now(),
    })
    item.audit.push({ id: `A-${Date.now()}`, at: '刚刚', operator: '当前用户', action: '金额改动', detail: `准备金由 ${oldAmount} 调整为 ${body.amount}，原支付依据失效并重算` })
    return of(new HttpResponse({ status: 200, body: { claim: item } })).pipe(delay(150))
  }

  return next(request)
}
