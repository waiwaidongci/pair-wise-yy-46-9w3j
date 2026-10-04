export type ClaimStatus = '查勘中' | '待复核' | '退回补件' | '审批中' | '待支付' | '已结案'

export type PaymentKind = '赔款支付' | '垫付'
export type ReceiptKind = '残值回收' | '追偿回款'
export type PaymentBasisStatus = '已生效' | '已失效'
export type PaymentStatus = '已确认' | '失败'
export type ReceiptStatus = '在途' | '已到账'
export type ConflictType = '付款冲突' | '对账差异' | '金额改动' | '依据失效'

/** 支付依据：由会签结果生成，同一案件同一时刻只有一份已生效依据 */
export type PaymentBasis = {
  id: string
  version: number
  amount: number
  status: PaymentBasisStatus
  source: string
  approvedBy: string
  approvedAt: string
  invalidatedReason?: string
  invalidatedAt?: string
}

/** 付款确认：同一支付号幂等，同一依据版本先到者生效 */
export type Payment = {
  id: string
  paymentNo: string
  basisVersion: number
  kind: PaymentKind
  amount: number
  payee: string
  status: PaymentStatus
  operator: string
  createdAt: string
}

/** 回款：残值回收或追偿回款，到账后冲减未结金额 */
export type Receipt = {
  id: string
  receiptNo: string
  kind: ReceiptKind
  amount: number
  status: ReceiptStatus
  createdAt: string
  arrivedAt?: string
}

/** 冲突记录：后到的付款内容、对账差异、金额改动等不予入账的事项 */
export type ConflictRecord = {
  id: string
  type: ConflictType
  paymentNo?: string
  basisVersion?: number
  content: string
  reason: string
  operator: string
  createdAt: string
}

export type FundLedger = {
  basis: PaymentBasis[]
  payments: Payment[]
  receipts: Receipt[]
  conflicts: ConflictRecord[]
}

export type PaymentRequest = {
  paymentNo: string
  kind: PaymentKind
  amount: number
  payee: string
  /** 模拟响应丢失：服务端已入账但返回 500，用于验证按原支付号重试不重复记账 */
  simulateFailure?: boolean
  /** 模拟两人同时提交：服务端按到达顺序串行处理 */
  concurrent?: boolean
}

export type ReceiptRequest = {
  receiptNo: string
  kind: ReceiptKind
  amount: number
}

export type PaymentResult = {
  applied: boolean
  payment?: Payment
  conflict?: ConflictRecord
  idempotent?: boolean
  failed?: boolean
  noBasis?: boolean
}


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
  audit: Array<{ id: string; at: string; operator: string; action: string; detail: string }>
  /** 资金台账：会签结果 → 支付依据 → 付款 → 回款，未结金额由此统一计算 */
  ledger?: FundLedger
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
