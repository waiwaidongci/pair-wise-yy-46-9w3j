import { HttpClient, HttpParams } from '@angular/common/http'
import { Injectable } from '@angular/core'
import type { ClaimCase, ClaimFilters, PagedClaims, PaymentBasis, PaymentRequest, PaymentResult, ReceiptRequest, Receipt } from './models'

@Injectable({ providedIn: 'root' })
export class ClaimsService {
  constructor(private readonly http: HttpClient) {}

  list(filters: ClaimFilters) {
    const params = new HttpParams()
      .set('query', filters.query)
      .set('status', filters.status)
      .set('risk', filters.risk)
      .set('page', filters.page)
      .set('pageSize', filters.pageSize)
    return this.http.get<PagedClaims>('/api/claims', { params })
  }

  get(id: string) {
    return this.http.get<ClaimCase>(`/api/claims/${id}`)
  }

  addQuote(claimId: string, body: { itemId: string; amount: number; reason: string }) {
    return this.http.post(`/api/claims/${claimId}/quotes`, body)
  }

  approve(claimId: string, body: { role: string; result: string; comment: string }) {
    return this.http.post(`/api/claims/${claimId}/approvals`, body)
  }

  /** 依据会签结果生成支付依据；会签未全部通过时返回 400 */
  createBasis(claimId: string) {
    return this.http.post<{ claim: ClaimCase; result: { basis?: PaymentBasis; error?: string } }>(`/api/claims/${claimId}/basis`, {})
  }

  /** 付款确认：同一支付号幂等，同一依据版本先到者生效、后到入冲突记录 */
  confirmPayment(claimId: string, body: PaymentRequest) {
    return this.http.post<{ claim: ClaimCase; result: PaymentResult }>(`/api/claims/${claimId}/payments`, body)
  }

  /** 登记回款（残值回收 / 追偿回款），初始为在途，到账后冲减未结 */
  registerReceipt(claimId: string, body: ReceiptRequest) {
    return this.http.post<{ claim: ClaimCase; result: { receipt: Receipt } }>(`/api/claims/${claimId}/receipts`, body)
  }

  /** 回款到账：冲减未结金额 */
  arriveReceipt(claimId: string, receiptNo: string) {
    return this.http.post<{ claim: ClaimCase; result: { receipt: Receipt } }>(`/api/claims/${claimId}/receipts/${receiptNo}/arrive`, {})
  }

  /** 对账差异：原支付依据失效，准备金重算 */
  postReconciliation(claimId: string, body: { difference: number; reason: string }) {
    return this.http.post<{ claim: ClaimCase }>(`/api/claims/${claimId}/reconciliation`, body)
  }

  /** 金额改动：原支付依据失效，准备金重算 */
  changeReserve(claimId: string, body: { amount: number; reason: string }) {
    return this.http.post<{ claim: ClaimCase }>(`/api/claims/${claimId}/reserve`, body)
  }
}
