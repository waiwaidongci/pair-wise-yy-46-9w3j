import { HttpClient, HttpParams } from '@angular/common/http'
import { Injectable } from '@angular/core'
import { Observable } from 'rxjs'
import type { ClaimCase, ClaimFilters, PagedClaims } from './models'
import type { ConfirmPaymentBody } from './ledger'

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
    return this.http.post<ClaimCase>(`/api/claims/${claimId}/quotes`, body)
  }

  approve(claimId: string, body: { role: string; result: string; comment: string }) {
    return this.http.post<ClaimCase>(`/api/claims/${claimId}/approvals`, body)
  }

  /** 付款确认：同一案件先到者生效，后到返回 409 且内容进冲突记录 */
  confirmPayment(claimId: string, body: ConfirmPaymentBody): Observable<ClaimCase> {
    return this.http.post<ClaimCase>(`/api/claims/${claimId}/fund/payments`, body)
  }

  /** 失败后按原支付号重试，沿用同一 paymentNo，不重复记账 */
  retryPayment(claimId: string, paymentNo: string, body: { operator: string; bankAccount: string; simulateFailure?: boolean }): Observable<ClaimCase> {
    return this.http.post<ClaimCase>(`/api/claims/${claimId}/fund/payments/${paymentNo}/retry`, body)
  }

  /** 残值回收 / 追偿回款到账，冲减未结金额 */
  postRecovery(claimId: string, body: { type: '残值回收' | '追偿回款'; amount: number; summary: string; operator: string }): Observable<ClaimCase> {
    return this.http.post<ClaimCase>(`/api/claims/${claimId}/fund/recoveries`, body)
  }

  /** 登记对账差异：原支付失效并重算准备金 */
  registerDiscrepancy(claimId: string, body: { amount: number; detail: string; operator: string }): Observable<ClaimCase> {
    return this.http.post<ClaimCase>(`/api/claims/${claimId}/fund/discrepancies`, body)
  }
}
