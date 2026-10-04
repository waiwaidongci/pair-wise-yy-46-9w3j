import { Component } from '@angular/core'
import { CommonModule, CurrencyPipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatTableModule } from '@angular/material/table'
import { MatCheckboxModule } from '@angular/material/checkbox'
import { Store } from '@ngrx/store'
import { map, type Observable } from 'rxjs'
import { ClaimsService } from '../core/claims.service'
import type { ClaimCase, PaymentKind, PaymentRequest, ReceiptKind } from '../core/models'
import { allApprovalsPassed, effectiveBasis, ledgerFigures, type LedgerFigures } from '../core/ledger'
import { selectAllClaims, selectSelectedClaim, selectClaim, updateClaim, type AppState } from '../core/claims.store'
import { StatusChipComponent } from '../shared/status-chip.component'

@Component({
  selector: 'app-funds-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CurrencyPipe,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTableModule,
    MatCheckboxModule,
    StatusChipComponent,
  ],
  template: `
    <section class="page" *ngIf="claim$ | async as claim">
      <div class="page-head">
        <div>
          <p class="eyebrow">FUND LEDGER / 资金台账</p>
          <h1>会签 · 支付 · 回款 一本账</h1>
          <p class="muted">同一案件只有一份已生效支付依据；付款先到者生效，回款到账冲减未结，差异令依据失效并重算准备金。</p>
        </div>
        <div class="actions">
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="case-picker">
            <mat-label>切换案件</mat-label>
            <mat-select [value]="claim.id" (valueChange)="pick($event)">
              <mat-option *ngFor="let item of claims$ | async" [value]="item.id">{{ item.id }} · {{ item.insured }}</mat-option>
            </mat-select>
          </mat-form-field>
        </div>
      </div>

      <div class="metrics" *ngIf="figures$ | async as f">
        <mat-card appearance="outlined"><span>案件准备金</span><strong>{{ f.reserve | currency:'CNY':'symbol':'1.0-0' }}</strong><small>会签与重算基准</small></mat-card>
        <mat-card appearance="outlined"><span>已付金额</span><strong>{{ f.paid | currency:'CNY':'symbol':'1.0-0' }}</strong><small>赔款支付 + 垫付</small></mat-card>
        <mat-card appearance="outlined"><span>已到账回款</span><strong class="good">{{ f.arrived | currency:'CNY':'symbol':'1.0-0' }}</strong><small>残值回收 + 追偿回款</small></mat-card>
        <mat-card appearance="outlined"><span>未结金额</span><strong [class.warn]="f.unsettled < 0">{{ f.unsettled | currency:'CNY':'symbol':'1.0-0' }}</strong><small *ngIf="f.inTransit > 0">在途回款 {{ f.inTransit | currency:'CNY':'symbol':'1.0-0' }} 未冲减</small><small *ngIf="f.inTransit === 0">准备金 - 已付 - 已到账回款</small></mat-card>
      </div>

      <div class="funds-grid">
        <div class="main-col">
          <section class="panel">
            <div class="panel-head">
              <h3>支付依据</h3>
              <span class="muted">由会签结果生成 · 同一案件同一时刻只有一份已生效依据</span>
            </div>
            <div class="basis-body">
              <div class="basis-current" *ngIf="effectiveBasis(claim.ledger) as basis">
                <div class="basis-tag">当前生效 · V{{ basis.version }}</div>
                <div class="basis-amount">{{ basis.amount | currency:'CNY':'symbol':'1.0-0' }}</div>
                <div class="basis-meta">
                  <span>{{ basis.source }}</span>
                  <span>{{ basis.approvedBy }} · {{ basis.approvedAt }}</span>
                </div>
              </div>
              <div class="basis-empty" *ngIf="!effectiveBasis(claim.ledger)">
                <mat-icon>gpp_maybe</mat-icon>
                <div>
                  <strong>暂无生效支付依据</strong>
                  <small *ngIf="!allApprovalsPassed(claim)">会签全部通过后可生成支付依据。</small>
                  <small *ngIf="allApprovalsPassed(claim)">会签已完成，可依据会签结果生成支付依据。</small>
                </div>
              </div>
              <div class="basis-actions">
                <button mat-flat-button color="primary" [disabled]="!allApprovalsPassed(claim) || !!effectiveBasis(claim.ledger)" (click)="createBasis(claim)">
                  <mat-icon>verified</mat-icon> 根据会签结果生成支付依据
                </button>
                <span class="muted" *ngIf="effectiveBasis(claim.ledger)">依据已生效，付款确认将计入该依据</span>
              </div>
              <div class="basis-history" *ngIf="(claim.ledger?.basis?.length ?? 0) > 0">
                <div *ngFor="let basis of claim.ledger?.basis" class="basis-row" [class.invalid]="basis.status === '已失效'">
                  <app-status-chip [label]="basis.status" [tone]="basis.status === '已生效' ? 'good' : 'default'" />
                  <strong>V{{ basis.version }}</strong>
                  <span>{{ basis.amount | currency:'CNY':'symbol':'1.0-0' }}</span>
                  <small>{{ basis.approvedAt }}<span *ngIf="basis.invalidatedReason"> · {{ basis.invalidatedReason }}</span></small>
                </div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h3>付款确认</h3>
              <span class="muted">同一支付号幂等 · 同一依据先到者生效，后到入冲突记录</span>
            </div>
            <div class="pay-form">
              <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>支付号</mat-label><input matInput [(ngModel)]="paymentNo" /></mat-form-field>
              <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>种类</mat-label>
                <mat-select [(ngModel)]="paymentKind">
                  <mat-option value="赔款支付">赔款支付</mat-option>
                  <mat-option value="垫付">垫付</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>金额</mat-label><input matInput type="number" [(ngModel)]="paymentAmount" /></mat-form-field>
              <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>收款方</mat-label><input matInput [(ngModel)]="paymentPayee" /></mat-form-field>
              <mat-checkbox [(ngModel)]="simulateFailure">模拟响应丢失（服务端已入账）</mat-checkbox>
              <div class="pay-actions">
                <button mat-flat-button color="primary" [disabled]="!paymentAmount || !paymentPayee.trim()" (click)="submitPayment(claim)">
                  <mat-icon>payments</mat-icon> 提交付款确认
                </button>
                <button mat-stroked-button color="primary" [disabled]="!paymentAmount || !paymentPayee.trim()" (click)="simulateConcurrent(claim)">
                  <mat-icon>bolt</mat-icon> 模拟两人同时提交
                </button>
              </div>
            </div>
            <div class="table-wrap" *ngIf="(claim.ledger?.payments?.length ?? 0) > 0">
              <table mat-table [dataSource]="claim.ledger?.payments ?? []">
                <ng-container matColumnDef="paymentNo"><th mat-header-cell *matHeaderCellDef>支付号</th><td mat-cell *matCellDef="let p">{{ p.paymentNo }}</td></ng-container>
                <ng-container matColumnDef="basis"><th mat-header-cell *matHeaderCellDef>依据</th><td mat-cell *matCellDef="let p">V{{ p.basisVersion }}</td></ng-container>
                <ng-container matColumnDef="kind"><th mat-header-cell *matHeaderCellDef>种类</th><td mat-cell *matCellDef="let p">{{ p.kind }}</td></ng-container>
                <ng-container matColumnDef="amount"><th mat-header-cell *matHeaderCellDef>金额</th><td mat-cell *matCellDef="let p">{{ p.amount | currency:'CNY':'symbol':'1.0-0' }}</td></ng-container>
                <ng-container matColumnDef="payee"><th mat-header-cell *matHeaderCellDef>收款方</th><td mat-cell *matCellDef="let p">{{ p.payee }}<small>{{ p.operator }} · {{ p.createdAt }}</small></td></ng-container>
                <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>状态</th><td mat-cell *matCellDef="let p"><app-status-chip [label]="p.status" [tone]="p.status === '已确认' ? 'good' : 'warn'" /></td></ng-container>
                <ng-container matColumnDef="retry"><th mat-header-cell *matHeaderCellDef></th><td mat-cell *matCellDef="let p"><button mat-button color="primary" (click)="retryPayment(claim, p.paymentNo)">按原号重试</button></td></ng-container>
                <tr mat-header-row *matHeaderRowDef="paymentColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: paymentColumns"></tr>
              </table>
            </div>
            <div class="empty-line" *ngIf="(claim.ledger?.payments?.length ?? 0) === 0">暂无付款记录，提交后计入资金台账。</div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h3>回款台账</h3>
              <span class="muted">残值回收与追偿回款 · 到账后冲减未结金额</span>
            </div>
            <div class="pay-form">
              <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>流水号</mat-label><input matInput [(ngModel)]="receiptNo" /></mat-form-field>
              <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>种类</mat-label>
                <mat-select [(ngModel)]="receiptKind">
                  <mat-option value="残值回收">残值回收</mat-option>
                  <mat-option value="追偿回款">追偿回款</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>金额</mat-label><input matInput type="number" [(ngModel)]="receiptAmount" /></mat-form-field>
              <button mat-flat-button color="primary" [disabled]="!receiptAmount" (click)="registerReceipt(claim)"><mat-icon>savings</mat-icon> 登记回款</button>
            </div>
            <div class="table-wrap" *ngIf="(claim.ledger?.receipts?.length ?? 0) > 0">
              <table mat-table [dataSource]="claim.ledger?.receipts ?? []">
                <ng-container matColumnDef="receiptNo"><th mat-header-cell *matHeaderCellDef>流水号</th><td mat-cell *matCellDef="let r">{{ r.receiptNo }}</td></ng-container>
                <ng-container matColumnDef="kind"><th mat-header-cell *matHeaderCellDef>种类</th><td mat-cell *matCellDef="let r">{{ r.kind }}</td></ng-container>
                <ng-container matColumnDef="amount"><th mat-header-cell *matHeaderCellDef>金额</th><td mat-cell *matCellDef="let r">{{ r.amount | currency:'CNY':'symbol':'1.0-0' }}</td></ng-container>
                <ng-container matColumnDef="status"><th mat-header-cell *matHeaderCellDef>状态</th><td mat-cell *matCellDef="let r"><app-status-chip [label]="r.status" [tone]="r.status === '已到账' ? 'good' : 'default'" /><small *ngIf="r.arrivedAt"> · {{ r.arrivedAt }}</small></td></ng-container>
                <ng-container matColumnDef="action"><th mat-header-cell *matHeaderCellDef></th><td mat-cell *matCellDef="let r"><button mat-button color="primary" [disabled]="r.status === '已到账'" (click)="arriveReceipt(claim, r.receiptNo)">{{ r.status === '已到账' ? '已到账' : '确认到账' }}</button></td></ng-container>
                <tr mat-header-row *matHeaderRowDef="receiptColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: receiptColumns"></tr>
              </table>
            </div>
            <div class="empty-line" *ngIf="(claim.ledger?.receipts?.length ?? 0) === 0">暂无回款记录。</div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h3>金额改动与对账差异</h3>
              <span class="muted">差异令原支付依据失效，准备金重算</span>
            </div>
            <div class="recon-grid">
              <div class="recon-card">
                <strong>金额改动</strong>
                <p>调整案件准备金，原支付依据失效并重算。</p>
                <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>新准备金</mat-label><input matInput type="number" [(ngModel)]="reserveAmount" /></mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>改动原因</mat-label><input matInput [(ngModel)]="reserveReason" placeholder="如：补充查勘依据后重估" /></mat-form-field>
                <button mat-stroked-button color="warn" [disabled]="!reserveAmount || !reserveReason.trim()" (click)="changeReserve(claim)"><mat-icon>tune</mat-icon> 改动金额并重算</button>
              </div>
              <div class="recon-card">
                <strong>对账差异</strong>
                <p>台账与银行流水差异，调整准备金并失效原依据。</p>
                <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>差异金额（正为调增）</mat-label><input matInput type="number" [(ngModel)]="reconDifference" /></mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>差异说明</mat-label><input matInput [(ngModel)]="reconReason" placeholder="如：银行已扣款未入账" /></mat-form-field>
                <button mat-stroked-button color="warn" [disabled]="reconDifference === 0 || !reconReason.trim()" (click)="postReconciliation(claim)"><mat-icon>difference</mat-icon> 登记对账差异</button>
              </div>
            </div>
          </section>
        </div>

        <aside class="side-col">
          <section class="panel">
            <div class="panel-head"><h3>冲突记录</h3><span class="muted">后到内容 · 不予入账</span></div>
            <div class="conflict-list" *ngIf="(claim.ledger?.conflicts?.length ?? 0) > 0">
              <div *ngFor="let c of claim.ledger?.conflicts" class="conflict-item">
                <div class="conflict-head">
                  <app-status-chip [label]="c.type" tone="warn" />
                  <small>{{ c.createdAt }}</small>
                </div>
                <p class="conflict-content">{{ c.content }}</p>
                <p class="conflict-reason">{{ c.reason }}</p>
                <small class="conflict-op">{{ c.operator }}<span *ngIf="c.paymentNo"> · 支付号 {{ c.paymentNo }}</span></small>
              </div>
            </div>
            <div class="empty-line" *ngIf="(claim.ledger?.conflicts?.length ?? 0) === 0">暂无冲突记录。两人同时提交付款时，后到内容会留在这里。</div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>会签进度</h3><span class="muted">通过后生成支付依据</span></div>
            <div class="approvals">
              <div *ngFor="let step of claim.approvals" class="approval-row">
                <mat-icon>{{ step.status === '已通过' ? 'check_circle' : step.status === '已退回' ? 'cancel' : 'radio_button_unchecked' }}</mat-icon>
                <div><strong>{{ step.role }}</strong><small>触发阈值 {{ step.threshold | currency:'CNY':'symbol':'1.0-0' }}<span *ngIf="step.operator"> · {{ step.operator }}</span></small></div>
                <app-status-chip [label]="step.status" [tone]="step.status === '已通过' ? 'good' : step.status === '已退回' ? 'warn' : 'default'" />
              </div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  `,
  styles: [`
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 12px; margin-bottom: 14px; }
    .metrics mat-card { padding: 15px; border-color: #dce3e6; }
    .metrics span, .metrics small { display: block; color: #6e7a83; font-size: 12px; }
    .metrics strong { display: block; margin: 6px 0; color: #153747; font-size: 24px; }
    .metrics .good { color: #246d55; }
    .metrics .warn { color: #b55a2e; }
    .case-picker { width: 280px; }
    .funds-grid { display: grid; grid-template-columns: minmax(0,1fr) 360px; gap: 14px; align-items: start; }
    .main-col, .side-col { display: grid; gap: 14px; }
    .side-col { align-content: start; }
    .basis-body { padding: 14px 16px 16px; }
    .basis-current { display: flex; align-items: center; gap: 16px; padding: 14px 16px; background: #eaf4f5; border-left: 3px solid #2f8191; border-radius: 6px; }
    .basis-tag { padding: 4px 9px; color: #175866; background: #d3eaed; border-radius: 5px; font-size: 11px; font-weight: 700; }
    .basis-amount { color: #175866; font-size: 22px; font-weight: 800; }
    .basis-meta { display: flex; flex-direction: column; gap: 2px; color: #5c7178; font-size: 11px; }
    .basis-empty { display: flex; align-items: center; gap: 12px; padding: 14px 16px; color: #8a6a3a; background: #fdf3e3; border-left: 3px solid #d9a441; border-radius: 6px; }
    .basis-empty mat-icon { font-size: 26px; width: 26px; height: 26px; }
    .basis-empty small { display: block; margin-top: 2px; color: #8a7a5a; font-size: 11px; }
    .basis-actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; flex-wrap: wrap; }
    .basis-history { margin-top: 14px; }
    .basis-row { display: flex; align-items: center; gap: 10px; padding: 9px 4px; border-bottom: 1px solid #edf0f2; font-size: 12px; }
    .basis-row.invalid { opacity: .62; }
    .basis-row strong { color: #175866; }
    .basis-row small { margin-left: auto; color: #8b969d; font-size: 10px; }
    .pay-form { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 14px 16px; }
    .pay-form mat-form-field { width: 150px; }
    .pay-form mat-checkbox { font-size: 12px; }
    .pay-actions { display: flex; gap: 8px; width: 100%; }
    .table-wrap { overflow-x: auto; padding: 0 16px 14px; }
    table { width: 100%; min-width: 640px; }
    td small { display: block; margin-top: 3px; color: #7b8790; font-size: 10px; }
    .empty-line { padding: 14px 16px; color: #8b969d; font-size: 12px; }
    .recon-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 14px 16px; }
    .recon-card { display: grid; gap: 8px; padding: 14px; border: 1px solid #e3e9ec; border-radius: 8px; background: #fafcfc; }
    .recon-card strong { color: #153747; font-size: 13px; }
    .recon-card p { margin: 0; color: #6c7a83; font-size: 11px; line-height: 1.5; }
    .recon-card mat-form-field { width: 100%; }
    .conflict-list { padding: 8px 14px 14px; }
    .conflict-item { padding: 11px 0; border-bottom: 1px solid #edf0f2; }
    .conflict-head { display: flex; align-items: center; justify-content: space-between; }
    .conflict-head small { color: #8b969d; font-size: 10px; }
    .conflict-content { margin: 7px 0 4px; color: #17323f; font-size: 12px; font-weight: 600; }
    .conflict-reason { margin: 0 0 4px; color: #984313; font-size: 11px; line-height: 1.5; }
    .conflict-op { color: #8b969d; font-size: 10px; }
    .approvals { padding: 8px 14px 14px; }
    .approval-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid #edf0f2; }
    .approval-row mat-icon { font-size: 20px; width: 20px; height: 20px; color: #2c7f89; }
    .approval-row strong, .approval-row small { display: block; }
    .approval-row small { margin-top: 2px; color: #8b969d; font-size: 10px; }
    .approval-row app-status-chip { margin-left: auto; }
    @media (max-width: 1100px) { .funds-grid { grid-template-columns: 1fr; } .metrics { grid-template-columns: repeat(2,1fr); } }
    @media (max-width: 620px) { .metrics { grid-template-columns: 1fr 1fr; } .recon-grid { grid-template-columns: 1fr; } }
  `],
})
export class FundsPageComponent {
  claim$: Observable<ClaimCase>
  claims$: Observable<ClaimCase[]>
  figures$: Observable<LedgerFigures>

  paymentColumns = ['paymentNo', 'basis', 'kind', 'amount', 'payee', 'status', 'retry']
  receiptColumns = ['receiptNo', 'kind', 'amount', 'status', 'action']

  paymentNo = ''
  paymentKind: PaymentKind = '赔款支付'
  paymentAmount = 0
  paymentPayee = ''
  simulateFailure = false

  receiptNo = ''
  receiptKind: ReceiptKind = '追偿回款'
  receiptAmount = 0

  reserveAmount = 0
  reserveReason = ''
  reconDifference = 0
  reconReason = ''

  constructor(
    private readonly store: Store<AppState>,
    private readonly service: ClaimsService,
    private readonly snackBar: MatSnackBar,
  ) {
    this.claims$ = this.store.select(selectAllClaims)
    this.claim$ = this.store.select(selectSelectedClaim)
    this.figures$ = this.claim$.pipe(map((claim) => ledgerFigures(claim)))
    this.claim$.subscribe((claim) => {
      this.reserveAmount = claim.reserve
    })
    this.resetPaymentNo()
    this.resetReceiptNo()
  }

  pick(id: string) {
    this.store.dispatch(selectClaim({ id }))
  }

  effectiveBasis = effectiveBasis
  allApprovalsPassed = allApprovalsPassed

  private resetPaymentNo() {
    this.paymentNo = `PAY-${Date.now()}`
  }

  private resetReceiptNo() {
    this.receiptNo = `RCT-${Date.now()}`
  }

  private patchClaim(claim: ClaimCase) {
    this.store.dispatch(updateClaim({ claim, silent: true }))
  }

  createBasis(claim: ClaimCase) {
    this.service.createBasis(claim.id).subscribe({
      next: (res) => {
        this.patchClaim(res.claim)
        if (res.result.error) {
          this.snackBar.open(res.result.error, '关闭', { duration: 2800 })
        } else {
          this.snackBar.open('支付依据已根据会签结果生成', '关闭', { duration: 2200 })
        }
      },
      error: () => this.snackBar.open('生成支付依据失败', '关闭', { duration: 2200 }),
    })
  }

  submitPayment(claim: ClaimCase) {
    const req: PaymentRequest = {
      paymentNo: this.paymentNo,
      kind: this.paymentKind,
      amount: Number(this.paymentAmount),
      payee: this.paymentPayee.trim(),
      simulateFailure: this.simulateFailure,
    }
    this.confirmPayment(claim, req)
  }

  /** 模拟两人同时提交：服务端按到达顺序串行处理，先到者生效，后到入冲突记录 */
  simulateConcurrent(claim: ClaimCase) {
    const base = Date.now()
    const reqA: PaymentRequest = {
      paymentNo: `PAY-${base}-A`,
      kind: this.paymentKind,
      amount: Number(this.paymentAmount),
      payee: `${this.paymentPayee.trim() || '收款方'}（提交人A）`,
      concurrent: true,
    }
    const reqB: PaymentRequest = {
      paymentNo: `PAY-${base}-B`,
      kind: this.paymentKind,
      amount: Number(this.paymentAmount),
      payee: `${this.paymentPayee.trim() || '收款方'}（提交人B）`,
      concurrent: true,
    }
    this.confirmPayment(claim, reqA)
    this.confirmPayment(claim, reqB)
  }

  /** 失败后按原支付号重试，不重复记账 */
  retryPayment(claim: ClaimCase, paymentNo: string) {
    this.confirmPayment(claim, { paymentNo, kind: this.paymentKind, amount: 0, payee: '' })
  }

  private confirmPayment(claim: ClaimCase, req: PaymentRequest) {
    this.service.confirmPayment(claim.id, req).subscribe({
      next: (res) => {
        this.patchClaim(res.claim)
        if (res.result.idempotent) {
          this.snackBar.open(`支付号 ${req.paymentNo} 已存在，未重复记账`, '关闭', { duration: 2600 })
        } else if (res.result.applied) {
          this.snackBar.open(`付款已确认，支付号 ${req.paymentNo} 已入账`, '关闭', { duration: 2400 })
        } else if (res.result.conflict) {
          this.snackBar.open(`后到内容已记入冲突记录，未入账：${res.result.conflict.reason}`, '关闭', { duration: 3600 })
        } else if (res.result.noBasis) {
          this.snackBar.open('无生效支付依据，请先生成支付依据', '关闭', { duration: 3000 })
        }
      },
      error: (err) => {
        const body = err.error
        if (body?.claim) this.patchClaim(body.claim)
        if (err.status === 409) {
          this.snackBar.open('无生效支付依据，请先生成支付依据', '关闭', { duration: 3000 })
          return
        }
        this.snackBar
          .open('支付响应丢失，可按原支付号重试（不会重复记账）', '重试', { duration: 6000 })
          .onAction()
          .subscribe(() => this.confirmPayment(claim, { ...req, simulateFailure: false }))
      },
    })
  }

  registerReceipt(claim: ClaimCase) {
    this.service.registerReceipt(claim.id, { receiptNo: this.receiptNo, kind: this.receiptKind, amount: Number(this.receiptAmount) }).subscribe({
      next: (res) => {
        this.patchClaim(res.claim)
        this.snackBar.open(`回款 ${this.receiptNo} 已登记（在途），到账后冲减未结`, '关闭', { duration: 2600 })
        this.resetReceiptNo()
        this.receiptAmount = 0
      },
      error: () => this.snackBar.open('回款登记失败', '关闭', { duration: 2200 }),
    })
  }

  arriveReceipt(claim: ClaimCase, receiptNo: string) {
    this.service.arriveReceipt(claim.id, receiptNo).subscribe({
      next: (res) => {
        this.patchClaim(res.claim)
        this.snackBar.open(`回款 ${receiptNo} 已到账，未结金额已冲减`, '关闭', { duration: 2400 })
      },
      error: () => this.snackBar.open('回款到账确认失败', '关闭', { duration: 2200 }),
    })
  }

  changeReserve(claim: ClaimCase) {
    this.service.changeReserve(claim.id, { amount: Number(this.reserveAmount), reason: this.reserveReason.trim() }).subscribe({
      next: (res) => {
        this.patchClaim(res.claim)
        this.snackBar.open('金额已改动，原支付依据失效，准备金已重算', '关闭', { duration: 2800 })
        this.reserveReason = ''
      },
      error: () => this.snackBar.open('金额改动失败', '关闭', { duration: 2200 }),
    })
  }

  postReconciliation(claim: ClaimCase) {
    this.service.postReconciliation(claim.id, { difference: Number(this.reconDifference), reason: this.reconReason.trim() }).subscribe({
      next: (res) => {
        this.patchClaim(res.claim)
        this.snackBar.open('对账差异已登记，原支付依据失效，准备金已重算', '关闭', { duration: 2800 })
        this.reconReason = ''
        this.reconDifference = 0
      },
      error: () => this.snackBar.open('对账差异登记失败', '关闭', { duration: 2200 }),
    })
  }
}
