import type { ClaimCase, FundLedger, LedgerEntry, PaymentBasis, ReconciliationIssue } from './models'

export type LedgerTotals = {
  /** 生效垫付（未被冲销的垫付流水） */
  paid: number
  /** 残值回收 + 追偿回款 */
  recovered: number
  /** 对账差异调整净额 */
  adjustment: number
  /** 当前生效依据金额；无生效依据时为 0 */
  activeBasisAmount: number
  /** 未结金额 = max(0, 生效垫付 - 已回款)，主管视图与台账共用同一口径 */
  outstanding: number
  /** 回款超过生效垫付的部分，自动登记为超额对账问题 */
  overRecovered: boolean
}

export type LedgerResult =
  | { ok: true; claim: ClaimCase }
  | { ok: false; status: number; error: string; claim: ClaimCase }

export function emptyFund(): FundLedger {
  return { bases: [], entries: [], conflicts: [], issues: [] }
}

export function ensureFund(claim: ClaimCase): FundLedger {
  if (!claim.fund) claim.fund = emptyFund()
  return claim.fund
}

/** 当前未失效依据：同一案件任一时点至多一份（待生效/支付失败/已生效） */
export function activeBasis(claim: ClaimCase): PaymentBasis | undefined {
  return ensureFund(claim).bases.find((basis) => basis.status !== '已失效')
}

export function effectiveBasis(claim: ClaimCase): PaymentBasis | undefined {
  return ensureFund(claim).bases.find((basis) => basis.status === '已生效')
}

export function ledgerTotals(claim: ClaimCase): LedgerTotals {
  const fund = ensureFund(claim)
  const live = fund.entries.filter((entry) => entry.entryStatus === '正常')
  const paid = live.filter((entry) => entry.type === '垫付').reduce((sum, entry) => sum + entry.amount, 0)
  const recovered = live
    .filter((entry) => entry.type === '残值回收' || entry.type === '追偿回款')
    .reduce((sum, entry) => sum + entry.amount, 0)
  const adjustment = live.filter((entry) => entry.type === '对账差异').reduce((sum, entry) => sum + entry.amount, 0)
  const basis = effectiveBasis(claim)
  const effectivePaid = basis ? Math.min(paid, basis.amount) : paid
  const outstanding = Math.max(0, effectivePaid - recovered)
  return {
    paid,
    recovered,
    adjustment,
    activeBasisAmount: basis?.amount ?? 0,
    outstanding,
    overRecovered: basis ? recovered > basis.amount : false,
  }
}

export function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function nextId(prefix: string, list: Array<{ id: string }>): string {
  const serial = list.length + 1
  const candidate = `${prefix}-${String(serial).padStart(3, '0')}`
  return list.some((item) => item.id === candidate) ? `${prefix}-${Date.now().toString(36)}${serial}` : candidate
}

function audit(claim: ClaimCase, action: string, detail: string, operator = '当前用户') {
  claim.audit.push({ id: `A-${Date.now()}-${claim.audit.length + 1}`, at: now(), operator, action, detail })
}

/** 准备金重算口径：(最新报价 - 预估残值) × 责任比例，扣除免赔额后不低于 0 */
export function recomputeReserve(claim: ClaimCase): number {
  const net = claim.lossItems.reduce(
    (sum, item) => sum + Math.max(0, (item.repairQuotes.at(-1)?.amount ?? 0) - item.salvage) * item.liability,
    0,
  )
  return Math.round(Math.max(0, net - claim.deductible))
}

/**
 * 金额改动或对账差异：原支付依据失效，垫付流水红冲但留痕，准备金按最新定损重算，会签回到第一级待处理。
 */
export function invalidateBasis(claim: ClaimCase, reason: string, operator = '当前用户'): boolean {
  const fund = ensureFund(claim)
  const basis = activeBasis(claim)
  if (!basis) return false

  basis.status = '已失效'
  basis.voidedAt = now()
  basis.voidReason = reason
  for (const entry of fund.entries) {
    if (entry.paymentNo === basis.paymentNo && entry.type === '垫付' && entry.entryStatus === '正常') {
      entry.entryStatus = '已冲销'
      entry.voidReason = reason
    }
  }
  claim.paid = ledgerTotals(claim).paid
  claim.reserve = recomputeReserve(claim)
  for (const step of claim.approvals) {
    if (step.threshold > 0) {
      step.status = '待处理'
      step.operator = undefined
      step.comment = undefined
      step.completedAt = undefined
    }
  }
  claim.status = '待复核'
  audit(claim, '支付依据失效', `支付依据 ${basis.paymentNo}（${basis.amount.toLocaleString('zh-CN')} 元）失效：${reason}；准备金重算为 ${claim.reserve.toLocaleString('zh-CN')} 元。`, operator)
  return true
}

/**
 * 会签最后一级通过时：生成唯一一份待生效支付依据。已有未失效依据或依据仍待生效时不重复立据。
 */
export function createPendingBasis(claim: ClaimCase): PaymentBasis | null {
  const existing = activeBasis(claim)
  if (existing) return null
  const version = claim.fund.bases.length + 1
  const basis: PaymentBasis = {
    paymentNo: `PAY-${claim.id.slice(-4)}-${String(version).padStart(2, '0')}`,
    version,
    amount: claim.reserve,
    sourceReserve: claim.reserve,
    status: '待生效',
    createdBy: '当前用户',
    createdAt: now(),
    attempts: 0,
  }
  claim.fund.bases.push(basis)
  claim.status = '待支付'
  audit(claim, '支付依据生成', `会签全部通过，生成待生效支付依据 ${basis.paymentNo}，金额 ${basis.amount.toLocaleString('zh-CN')} 元。`)
  return basis
}

function addConflict(
  claim: ClaimCase,
  basis: PaymentBasis,
  body: { operator: string; amount: number; bankAccount: string; clientToken?: string },
  reason: string,
) {
  const fund = ensureFund(claim)
  fund.conflicts.push({
    id: nextId('CFL', fund.conflicts),
    at: now(),
    paymentNo: basis.paymentNo,
    version: basis.version,
    operator: body.operator,
    amount: body.amount,
    bankAccount: body.bankAccount,
    reason,
    clientToken: body.clientToken,
  })
  audit(claim, '付款确认冲突', `支付依据 ${basis.paymentNo}：${body.operator} 提交的 ${body.amount.toLocaleString('zh-CN')} 元被拒绝（${reason}），内容已留存冲突记录。`)
}

export type ConfirmPaymentBody = {
  operator: string
  amount: number
  bankAccount: string
  clientToken?: string
  /** 模拟银行通道返回失败，用于演示按原号重试 */
  simulateFailure?: boolean
}

/**
 * 付款确认（双人同时提交）：先到者生效并记一笔垫付流水；后到者不覆盖，内容进冲突记录。
 * 幂等：同一 clientToken 重复提交直接返回既有结果，不重复记账。
 */
export function confirmPayment(claim: ClaimCase, body: ConfirmPaymentBody): LedgerResult {
  const fund = ensureFund(claim)
  const duplicate = fund.entries.find((entry) => entry.clientToken && entry.clientToken === body.clientToken)
  if (body.clientToken && duplicate) {
    return { ok: true, claim }
  }
  const conflicted = fund.conflicts.find((item) => item.clientToken && item.clientToken === body.clientToken)
  if (body.clientToken && conflicted) {
    return { ok: false, status: 409, error: conflicted.reason, claim }
  }

  const basis = activeBasis(claim)
  if (!basis) {
    return { ok: false, status: 409, error: '该案件没有待生效的支付依据，请先完成会签立据', claim }
  }

  if (basis.status === '已生效') {
    addConflict(claim, basis, body, '先到者已确认生效，同一支付依据只允许一份生效结果')
    return { ok: false, status: 409, error: '已有生效支付依据：先到者生效，后到内容已留存冲突记录', claim }
  }

  if (body.amount !== basis.amount) {
    addConflict(claim, basis, body, `确认金额 ${body.amount.toLocaleString('zh-CN')} 与依据金额 ${basis.amount.toLocaleString('zh-CN')} 不一致`)
    return { ok: false, status: 409, error: '确认金额与支付依据不一致，内容已留存冲突记录', claim }
  }

  basis.attempts += 1
  if (body.simulateFailure) {
    basis.status = '支付失败'
    basis.lastError = '银行通道返回：余额不足/通道超时，请按原支付号重试'
    audit(claim, '赔款支付失败', `支付依据 ${basis.paymentNo} 第 ${basis.attempts} 次提交失败：${basis.lastError}。`, body.operator)
    return { ok: false, status: 502, error: basis.lastError, claim }
  }

  basis.status = '已生效'
  basis.confirmedBy = body.operator
  basis.confirmedAt = now()
  basis.bankAccount = body.bankAccount
  basis.lastError = undefined
  const entry: LedgerEntry = {
    id: nextId('E', fund.entries),
    at: now(),
    type: '垫付',
    direction: '付',
    paymentNo: basis.paymentNo,
    amount: basis.amount,
    summary: `赔款垫付（支付依据 ${basis.paymentNo}）`,
    operator: body.operator,
    clientToken: body.clientToken,
    entryStatus: '正常',
  }
  fund.entries.push(entry)
  claim.paid = ledgerTotals(claim).paid
  const totals = ledgerTotals(claim)
  if (totals.outstanding === 0 && totals.paid > 0) claim.status = '已结案'
  audit(claim, '赔款支付生效', `先到确认（${body.operator}）生效：${basis.paymentNo} 垫付 ${basis.amount.toLocaleString('zh-CN')} 元，未结 ${totals.outstanding.toLocaleString('zh-CN')} 元。`)
  return { ok: true, claim }
}

/**
 * 失败后按原支付号重试：沿用同一 paymentNo，不生成新依据、不重复记账。
 */
export function retryPayment(claim: ClaimCase, paymentNo: string, body: Omit<ConfirmPaymentBody, 'amount'>): LedgerResult {
  const basis = ensureFund(claim).bases.find((item) => item.paymentNo === paymentNo)
  if (!basis) return { ok: false, status: 404, error: '未找到对应支付号', claim }
  if (basis.status === '已生效') {
    return { ok: false, status: 409, error: '该支付号已生效，无需重试，不会重复记账', claim }
  }
  if (basis.status === '已失效') {
    return { ok: false, status: 409, error: '该支付号已因金额改动/对账差异失效，请重新会签立据', claim }
  }
  return confirmPayment(claim, { ...body, amount: basis.amount })
}

/**
 * 回款到账（残值回收 / 追偿回款）：冲减未结金额；clientToken 幂等。回款超过垫付时登记超额问题。
 */
export function postRecovery(
  claim: ClaimCase,
  body: { type: '残值回收' | '追偿回款'; amount: number; summary: string; operator: string; clientToken?: string },
): LedgerResult {
  if (!(body.amount > 0)) return { ok: false, status: 400, error: '回款金额必须大于 0', claim }
  const fund = ensureFund(claim)
  if (body.clientToken && fund.entries.some((entry) => entry.clientToken === body.clientToken)) {
    return { ok: true, claim }
  }
  const basis = effectiveBasis(claim)
  fund.entries.push({
    id: nextId('E', fund.entries),
    at: now(),
    type: body.type,
    direction: '收',
    paymentNo: basis?.paymentNo,
    amount: body.amount,
    summary: body.summary || `${body.type}到账`,
    operator: body.operator,
    clientToken: body.clientToken,
    entryStatus: '正常',
  })
  const totals = ledgerTotals(claim)
  if (totals.overRecovered && !fund.issues.some((issue) => issue.kind === '超额回款' && !issue.resolved)) {
    const excess = Math.round((totals.recovered - totals.activeBasisAmount) * 100) / 100
    const issue: ReconciliationIssue = {
      id: nextId('REC', fund.issues),
      at: now(),
      kind: '超额回款',
      amount: excess,
      detail: `回款累计 ${totals.recovered.toLocaleString('zh-CN')} 元超过生效垫付 ${totals.activeBasisAmount.toLocaleString('zh-CN')} 元，超出 ${excess.toLocaleString('zh-CN')} 元待核实。`,
      resolved: false,
    }
    fund.issues.push(issue)
    audit(claim, '超额回款预警', issue.detail, body.operator)
  }
  if (totals.outstanding === 0 && basis) claim.status = '已结案'
  audit(
    claim,
    body.type,
    `${body.summary || body.type + '到账'} ${body.amount.toLocaleString('zh-CN')} 元，未结金额冲减为 ${totals.outstanding.toLocaleString('zh-CN')} 元。`,
    body.operator,
  )
  return { ok: true, claim }
}

/**
 * 登记对账差异：原支付依据失效并重算准备金；差异同时以调整流水留痕。
 */
export function registerDiscrepancy(claim: ClaimCase, body: { amount: number; detail: string; operator: string }): LedgerResult {
  if (!body.detail?.trim()) return { ok: false, status: 400, error: '必须填写对账差异说明', claim }
  const fund = ensureFund(claim)
  const basis = activeBasis(claim)
  fund.issues.push({
    id: nextId('REC', fund.issues),
    at: now(),
    kind: '对账差异',
    amount: body.amount,
    detail: body.detail,
    resolved: false,
  })
  fund.entries.push({
    id: nextId('E', fund.entries),
    at: now(),
    type: '对账差异',
    direction: '调整',
    paymentNo: basis?.paymentNo,
    amount: body.amount,
    summary: `对账差异：${body.detail}`,
    operator: body.operator,
    entryStatus: '正常',
  })
  if (basis) {
    invalidateBasis(claim, `对账差异：${body.detail}`, body.operator)
  } else {
    claim.reserve = recomputeReserve(claim)
    audit(claim, '对账差异登记', `${body.detail}（差异 ${body.amount.toLocaleString('zh-CN')} 元）；当前无生效依据，准备金重算为 ${claim.reserve.toLocaleString('zh-CN')} 元。`, body.operator)
  }
  return { ok: true, claim }
}
