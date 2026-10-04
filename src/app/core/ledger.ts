import type { ClaimCase, FundLedger, PaymentBasis } from './models'

export function emptyLedger(): FundLedger {
  return { basis: [], payments: [], receipts: [], conflicts: [] }
}

export function effectiveBasis(ledger: FundLedger | undefined): PaymentBasis | undefined {
  return ledger?.basis.find((basis) => basis.status === '已生效')
}

export function allApprovalsPassed(claim: ClaimCase): boolean {
  return claim.approvals.length > 0 && claim.approvals.every((step) => step.status === '已通过')
}

export type LedgerFigures = {
  reserve: number
  paid: number
  arrived: number
  inTransit: number
  unsettled: number
}

/** 未结金额 = 准备金 - 已付 - 已到账回款；在途回款不冲减 */
export function ledgerFigures(claim: ClaimCase): LedgerFigures {
  const ledger = claim.ledger ?? emptyLedger()
  const paid = ledger.payments.filter((p) => p.status === '已确认').reduce((sum, p) => sum + p.amount, 0)
  const arrived = ledger.receipts.filter((r) => r.status === '已到账').reduce((sum, r) => sum + r.amount, 0)
  const inTransit = ledger.receipts.filter((r) => r.status === '在途').reduce((sum, r) => sum + r.amount, 0)
  return { reserve: claim.reserve, paid, arrived, inTransit, unsettled: claim.reserve - paid - arrived }
}
