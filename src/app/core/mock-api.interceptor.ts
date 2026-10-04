import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http'
import { delay, of, switchMap, throwError, timer } from 'rxjs'
import { seedClaims } from './seed'
import type { ClaimCase } from './models'
import {
  activeBasis,
  confirmPayment,
  createPendingBasis,
  ensureFund,
  invalidateBasis,
  postRecovery,
  registerDiscrepancy,
  retryPayment,
  type ConfirmPaymentBody,
  type LedgerResult,
} from './ledger'

let claims = structuredClone(seedClaims)

function findClaim(id: string | undefined): ClaimCase | undefined {
  return claims.find((claim) => claim.id === id)
}

/** 台账引擎结果 → HTTP 响应 / 4xx-5xx 错误（冲突与失败均已在案件上留痕） */
function toResponse(result: LedgerResult, delayMs = 260) {
  const stream$ = result.ok
    ? of(new HttpResponse({ status: 200, body: result.claim }))
    : throwError(() => new HttpErrorResponse({ status: result.status, statusText: result.error, error: { message: result.error } }))
  return stream$.pipe(delay(delayMs))
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
    const item = findClaim(request.url.split('/').pop())
    return item ? of(new HttpResponse({ status: 200, body: item })).pipe(delay(120)) : throwError(() => new HttpErrorResponse({ status: 404 }))
  }

  if (request.method === 'POST' && request.url.endsWith('/quotes')) {
    const id = request.url.split('/').at(-2)
    const body = request.body as { itemId: string; amount: number; reason: string }
    const claim = findClaim(id)
    const item = claim?.lossItems.find((loss) => loss.id === body.itemId)
    if (!claim || !item) return throwError(() => new HttpErrorResponse({ status: 404 }))
    item.repairQuotes.push({
      version: item.repairQuotes.length + 1,
      amount: body.amount,
      reason: body.reason,
      operator: '当前用户',
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    })
    // 金额改动：若已有未失效支付依据，原依据失效、垫付红冲、准备金重算
    if (activeBasis(claim)) {
      invalidateBasis(claim, `损失科目「${item.category}」报价由 ${item.repairQuotes.at(-2)?.amount.toLocaleString('zh-CN')} 元调整为 ${body.amount.toLocaleString('zh-CN')} 元：${body.reason}`)
    }
    return of(new HttpResponse({ status: 201, body: claim })).pipe(delay(180))
  }

  if (request.method === 'POST' && request.url.endsWith('/approvals')) {
    const id = request.url.split('/').at(-2)
    const body = request.body as { role: string; result: string; comment: string }
    const claim = findClaim(id)
    const step = claim?.approvals.find((approval) => approval.role === body.role)
    if (!claim || !step) return throwError(() => new HttpErrorResponse({ status: 404 }))
    step.status = body.result === '已通过' ? '已通过' : '已退回'
    step.operator = '当前用户'
    step.comment = body.comment
    step.completedAt = new Date().toLocaleString('zh-CN', { hour12: false })
    ensureFund(claim)
    claim.audit.push({ id: `A-${Date.now()}`, at: step.completedAt, operator: '当前用户', action: `会签${step.status}`, detail: body.comment })
    if (body.result !== '已通过') {
      claim.status = '退回补件'
    } else {
      const pending = claim.approvals.filter((approval) => approval.status === '待处理').length
      if (pending === 0) {
        // 会签全部通过：同一案件只立一份待生效支付依据
        const basis = createPendingBasis(claim)
        claim.status = basis ? '待支付' : '审批中'
      } else {
        claim.status = '审批中'
      }
    }
    return of(new HttpResponse({ status: 200, body: claim })).pipe(delay(180))
  }

  // —— 资金台账 ——

  if (request.method === 'POST' && request.url.endsWith('/fund/payments')) {
    const claimId = request.url.split('/').at(-3)
    const claim = findClaim(claimId)
    if (!claim) return throwError(() => new HttpErrorResponse({ status: 404 }))
    const incoming = request.body as Partial<ConfirmPaymentBody>
    const body: ConfirmPaymentBody = {
      operator: incoming.operator || '当前用户',
      amount: Number(incoming.amount) || 0,
      bankAccount: incoming.bankAccount || '',
      clientToken: incoming.clientToken,
      simulateFailure: Boolean(incoming.simulateFailure),
    }
    // 模拟双人同时点击：随机 120~420ms 银行通道延迟，先完成者落账
    const latency = 120 + Math.floor(Math.random() * 300)
    return timer(latency).pipe(switchMap(() => toResponse(confirmPayment(claim, body))))
  }

  const retryMatch = request.url.match(/\/api\/claims\/[^/]+\/fund\/payments\/([^/]+)\/retry$/)
  if (request.method === 'POST' && retryMatch) {
    const claim = findClaim(request.url.split('/').at(-4))
    if (!claim) return throwError(() => new HttpErrorResponse({ status: 404 }))
    const body = request.body as { operator: string; bankAccount: string; simulateFailure?: boolean }
    return timer(150 + Math.floor(Math.random() * 200)).pipe(
      switchMap(() => toResponse(retryPayment(claim, decodeURIComponent(retryMatch[1]), { operator: body.operator ?? '当前用户', bankAccount: body.bankAccount ?? '', simulateFailure: body.simulateFailure }))),
    )
  }

  if (request.method === 'POST' && request.url.endsWith('/fund/recoveries')) {
    const claim = findClaim(request.url.split('/').at(-3))
    if (!claim) return throwError(() => new HttpErrorResponse({ status: 404 }))
    const body = request.body as { type: '残值回收' | '追偿回款'; amount: number; summary: string; operator: string }
    return toResponse(postRecovery(claim, { ...body, operator: body.operator ?? '当前用户', clientToken: `RCV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }))
  }

  if (request.method === 'POST' && request.url.endsWith('/fund/discrepancies')) {
    const claim = findClaim(request.url.split('/').at(-3))
    if (!claim) return throwError(() => new HttpErrorResponse({ status: 404 }))
    const body = request.body as { amount: number; detail: string; operator: string }
    return toResponse(registerDiscrepancy(claim, { amount: Number(body.amount) || 0, detail: body.detail ?? '', operator: body.operator ?? '当前用户' }))
  }

  return next(request)
}
