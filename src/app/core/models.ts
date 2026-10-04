export type ClaimStatus = '查勘中' | '待复核' | '退回补件' | '审批中' | '待支付' | '已结案'

export type Attachment = {
  id: string
  name: string
  category: '现场照片' | '修复报告' | '专家意见' | '保单摘录'
  version: number
  uploadedBy: string
  uploadedAt: string
}

export type LossItem = {
  id: string
  category: string
  description: string
  damage: string
  repairQuotes: Array<{ version: number; amount: number; reason: string; operator: string; createdAt: string }>
  salvage: number
  liability: number
  disputed: boolean
  attachments: Attachment[]
  expertNotes: string[]
}

export type ApprovalStep = {
  role: string
  threshold: number
  status: '待处理' | '已通过' | '已退回'
  operator?: string
  comment?: string
  completedAt?: string
}

/** 支付依据状态：会签通过后待生效；付款确认成功后已生效；银行返回失败可按原号重试；改价/差异使其失效 */
export type BasisStatus = '待生效' | '已生效' | '支付失败' | '已失效'

/** 同一案件任一时点只有一份未失效的支付依据（待生效/已生效互斥且唯一） */
export type PaymentBasis = {
  paymentNo: string
  version: number
  amount: number
  sourceReserve: number
  status: BasisStatus
  createdBy: string
  createdAt: string
  confirmedBy?: string
  confirmedAt?: string
  bankAccount?: string
  attempts: number
  lastError?: string
  voidedAt?: string
  voidReason?: string
}

/** 资金台账流水：只增不改；垫付被红冲时 entryStatus 置为已冲销，行仍保留可追溯 */
export type LedgerEntry = {
  id: string
  at: string
  type: '垫付' | '残值回收' | '追偿回款' | '对账差异'
  direction: '付' | '收' | '调整'
  paymentNo?: string
  amount: number
  summary: string
  operator: string
  clientToken?: string
  entryStatus: '正常' | '已冲销'
  voidReason?: string
}

/** 后到的付款确认（已有生效依据 / 金额不一致）不覆盖先到结果，内容原样留存在冲突记录 */
export type PaymentConflict = {
  id: string
  at: string
  paymentNo: string
  version: number
  operator: string
  amount: number
  bankAccount: string
  reason: string
  clientToken?: string
}

export type ReconciliationIssue = {
  id: string
  at: string
  kind: '对账差异' | '超额回款'
  amount: number
  detail: string
  resolved: boolean
}

/** 案件资金台账：会签结果、赔款支付、残值/追偿回流的唯一记账来源 */
export type FundLedger = {
  bases: PaymentBasis[]
  entries: LedgerEntry[]
  conflicts: PaymentConflict[]
  issues: ReconciliationIssue[]
}

export type ClaimCase = {
  id: string
  policyNo: string
  insured: string
  lossAddress: string
  accidentDate: string
  reportedAt: string
  adjuster: string
  status: ClaimStatus
  riskLevel: '低' | '中' | '高'
  reserve: number
  paid: number
  deductible: number
  lossItems: LossItem[]
  approvals: ApprovalStep[]
  fund: FundLedger
  audit: Array<{ id: string; at: string; operator: string; action: string; detail: string }>
}

export type ClaimFilters = {
  query: string
  status: string
  risk: string
  page: number
  pageSize: number
}

export type PagedClaims = {
  items: ClaimCase[]
  total: number
  page: number
  pageSize: number
}
