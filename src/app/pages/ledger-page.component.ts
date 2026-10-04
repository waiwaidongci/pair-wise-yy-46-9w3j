import { Component } from '@angular/core'
import { CommonModule, CurrencyPipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatCardModule } from '@angular/material/card'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatIconModule } from '@angular/material/icon'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatTableModule } from '@angular/material/table'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatSlideToggleModule } from '@angular/material/slide-toggle'
import { Store } from '@ngrx/store'
import { Observable } from 'rxjs'
import { ClaimsService } from '../core/claims.service'
import { ensureFund, ledgerTotals } from '../core/ledger'
import type { ClaimCase, FundLedger } from '../core/models'
import { selectAllClaims, selectClaim, selectSelectedClaim, updateClaim, type AppState } from '../core/claims.store'
import { StatusChipComponent } from '../shared/status-chip.component'

@Component({
  selector: 'app-ledger-page',
  standalone: true,
  imports: [
    CommonModule,
    CurrencyPipe,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTableModule,
    StatusChipComponent,
  ],
  template: `
    <section class="page" *ngIf="claim$ | async as claim">
      <div class="page-head">
        <div>
          <p class="eyebrow">FUND LEDGER / 资金台账</p>
          <h1>{{ claim.id }} · 赔款支付与追偿回款</h1>
          <p class="muted">会签结果、垫付、残值回收、追偿回款同账登记；已付与未结金额对主管视图同源可见。</p>
        </div>
        <div class="actions">
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="case-picker">
            <mat-label>切换案件</mat-label>
            <mat-select [ngModel]="claim.id" (ngModelChange)="switchCase($event)">
              <mat-option *ngFor="let item of claims$ | async" [value]="item.id">{{ item.id }} · {{ item.insured }}</mat-option>
            </mat-select>
          </mat-form-field>
        </div>
      </div>

      <div class="metrics">
        <mat-card appearance="outlined"><span>当前准备金</span><strong>{{ claim.reserve | currency:'CNY':'symbol':'1.0-0' }}</strong><small>金额改动/差异后自动重算</small></mat-card>
        <mat-card appearance="outlined"><span>已付（生效垫付）</span><strong class="pay">{{ totals(claim).paid | currency:'CNY':'symbol':'1.0-0' }}</strong><small>同一案件仅一份生效依据</small></mat-card>
        <mat-card appearance="outlined"><span>已回款（残值+追偿）</span><strong class="recv">{{ totals(claim).recovered | currency:'CNY':'symbol':'1.0-0' }}</strong><small>到账即冲减未结</small></mat-card>
        <mat-card appearance="outlined"><span>未结金额</span><strong [class.warn]="totals(claim).outstanding > 0" [class.done]="totals(claim).outstanding === 0">
          {{ totals(claim).outstanding | currency:'CNY':'symbol':'1.0-0' }}
        </strong><small>max(0, 生效垫付 - 已回款)</small></mat-card>
      </div>

      <div class="ledger-grid">
        <div class="col">
          <!-- 支付依据与付款确认 -->
          <section class="panel">
            <div class="panel-head">
              <h3>支付依据与付款确认</h3>
              <span class="muted">两人同时提交：先到者生效</span>
            </div>
            <div class="basis-list">
              <p *ngIf="fund(claim).bases.length === 0" class="empty">
                <mat-icon>hourglass_empty</mat-icon>
                会签尚未全部通过，通过后在此自动生成唯一一份待生效支付依据。
              </p>
              <article *ngFor="let basis of fund(claim).bases.slice().reverse()" [class.inactive]="basis.status === '已失效'">
                <header>
                  <div>
                    <strong>{{ basis.paymentNo }} <small>V{{ basis.version }}</small></strong>
                    <span class="muted">立据 {{ basis.createdAt }} · {{ basis.createdBy }}</span>
                  </div>
                  <app-status-chip
                    [label]="basis.status"
                    [tone]="basis.status === '已生效' ? 'good' : basis.status === '已失效' ? 'default' : 'warn'" />
                </header>
                <div class="basis-meta">
                  <div><span>依据金额</span><strong>{{ basis.amount | currency:'CNY':'symbol':'1.0-0' }}</strong></div>
                  <div><span>来源准备金</span><strong>{{ basis.sourceReserve | currency:'CNY':'symbol':'1.0-0' }}</strong></div>
                  <div><span>提交次数</span><strong>{{ basis.attempts }}</strong></div>
                </div>
                <p *ngIf="basis.confirmedAt" class="meta-line">生效确认：{{ basis.confirmedBy }} · {{ basis.confirmedAt }} · 收款账 {{ basis.bankAccount }}</p>
                <p *ngIf="basis.voidedAt" class="meta-line void">失效于 {{ basis.voidedAt }}：{{ basis.voidReason }}</p>
                <p *ngIf="basis.lastError" class="meta-line err">最近失败：{{ basis.lastError }}</p>

                <!-- 待生效：双人同时确认演示 -->
                <div class="confirm-box" *ngIf="basis.status === '待生效'">
                  <div class="confirm-row">
                    <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>确认人</mat-label><input matInput [(ngModel)]="operatorA" /></mat-form-field>
                    <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>确认金额</mat-label><input matInput type="number" [(ngModel)]="amountA" /></mat-form-field>
                    <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>收款账号</mat-label><input matInput [(ngModel)]="accountA" /></mat-form-field>
                  </div>
                  <div class="confirm-actions">
                    <mat-slide-toggle [(ngModel)]="simulateFail">模拟银行通道失败（演示原号重试）</mat-slide-toggle>
                    <span class="spacer"></span>
                    <button mat-stroked-button color="primary" [disabled]="busy" (click)="raceConfirm(claim, basis.paymentNo)">
                      <mat-icon>groups</mat-icon> 双人同时提交确认
                    </button>
                    <button mat-flat-button color="primary" [disabled]="busy" (click)="singleConfirm(claim, basis.paymentNo)">
                      <mat-icon>payments</mat-icon> 付款确认
                    </button>
                  </div>
                  <p class="hint">「双人同时提交」将以两位确认人、随机通道延迟并发请求同一依据，先到者生效，后到内容进入下方冲突记录。</p>
                </div>

                <!-- 支付失败：按原号重试 -->
                <div class="confirm-box retry" *ngIf="basis.status === '支付失败'">
                  <div class="confirm-row">
                    <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>重试确认人</mat-label><input matInput [(ngModel)]="operatorA" /></mat-form-field>
                    <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>原收款账号</mat-label><input matInput [(ngModel)]="accountA" /></mat-form-field>
                  </div>
                  <div class="confirm-actions">
                    <mat-slide-toggle [(ngModel)]="simulateFail">再次模拟失败</mat-slide-toggle>
                    <span class="spacer"></span>
                    <button mat-flat-button color="primary" [disabled]="busy" (click)="retry(claim, basis.paymentNo)">
                      <mat-icon>restart_alt</mat-icon> 按原支付号 {{ basis.paymentNo }} 重试
                    </button>
                  </div>
                  <p class="hint">沿用原支付号，不生成新依据、不重复记账；成功后补记同一笔垫付流水。</p>
                </div>
              </article>
            </div>
          </section>

          <!-- 回款登记 -->
          <section class="panel">
            <div class="panel-head"><h3>回款登记（冲减未结）</h3><span class="muted">残值 / 追偿分开记账</span></div>
            <div class="recovery-box">
              <div class="confirm-row">
                <mat-form-field appearance="outline" subscriptSizing="dynamic">
                  <mat-label>回款类型</mat-label>
                  <mat-select [(ngModel)]="recoveryType">
                    <mat-option value="残值回收">残值回收</mat-option>
                    <mat-option value="追偿回款">追偿回款</mat-option>
                  </mat-select>
                </mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>到账金额</mat-label><input matInput type="number" [(ngModel)]="recoveryAmount" /></mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="grow"><mat-label>说明 / 对方账户</mat-label><input matInput [(ngModel)]="recoverySummary" /></mat-form-field>
              </div>
              <div class="confirm-actions">
                <span class="spacer"></span>
                <button mat-flat-button color="primary" [disabled]="!recoveryAmount || recoveryAmount <= 0" (click)="registerRecovery(claim)">
                  <mat-icon>download_done</mat-icon> 回款到账
                </button>
              </div>
            </div>
          </section>

          <!-- 对账差异登记 -->
          <section class="panel">
            <div class="panel-head"><h3>对账差异</h3><span class="muted">登记后原支付失效并重算准备金</span></div>
            <div class="recovery-box">
              <div class="confirm-row">
                <mat-form-field appearance="outline" subscriptSizing="dynamic"><mat-label>差异金额（差异方向，正/负）</mat-label><input matInput type="number" [(ngModel)]="diffAmount" /></mat-form-field>
                <mat-form-field appearance="outline" subscriptSizing="dynamic" class="grow"><mat-label>差异说明（必填）</mat-label><input matInput [(ngModel)]="diffDetail" /></mat-form-field>
              </div>
              <div class="confirm-actions">
                <span class="spacer"></span>
                <button mat-stroked-button color="warn" [disabled]="!diffDetail.trim()" (click)="registerDiff(claim)">
                  <mat-icon>difference</mat-icon> 登记差异并重算
                </button>
              </div>
            </div>
          </section>
        </div>

        <aside>
          <section class="panel">
            <div class="panel-head"><h3>资金台账流水</h3><span class="muted">{{ fund(claim).entries.length }} 笔 · 只增不删</span></div>
            <div class="table-wrap">
              <table mat-table [dataSource]="fund(claim).entries.slice().reverse()">
                <ng-container matColumnDef="at"><th mat-header-cell *matHeaderCellDef>时间</th><td mat-cell *matCellDef="let e">{{ e.at }}</td></ng-container>
                <ng-container matColumnDef="type">
                  <th mat-header-cell *matHeaderCellDef>类型</th>
                  <td mat-cell *matCellDef="let e">
                    <app-status-chip [label]="e.type" [tone]="e.direction === '收' ? 'good' : e.direction === '付' ? 'warn' : 'default'" />
                    <small *ngIf="e.entryStatus === '已冲销'" class="void-tag">已冲销：{{ e.voidReason }}</small>
                  </td>
                </ng-container>
                <ng-container matColumnDef="summary"><th mat-header-cell *matHeaderCellDef>摘要</th><td mat-cell *matCellDef="let e">{{ e.summary }}<small>{{ e.operator }}<ng-container *ngIf="e.paymentNo"> · {{ e.paymentNo }}</ng-container></small></td></ng-container>
                <ng-container matColumnDef="amount">
                  <th mat-header-cell *matHeaderCellDef>金额</th>
                  <td mat-cell *matCellDef="let e" [class.amt-pay]="e.direction === '付'" [class.amt-recv]="e.direction === '收'">
                    {{ e.direction === '收' ? '+' : e.direction === '付' ? '−' : '±' }}{{ e.amount | currency:'CNY':'symbol':'1.0-0' }}
                  </td>
                </ng-container>
                <tr mat-header-row *matHeaderRowDef="entryColumns"></tr>
                <tr mat-row *matRowDef="let row; columns: entryColumns" [class.voided-row]="row.entryStatus === '已冲销'"></tr>
              </table>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h3>付款确认冲突记录</h3><span class="muted">{{ fund(claim).conflicts.length }} 条 · 后到内容留存</span></div>
            <div class="conflict-list">
              <p *ngIf="fund(claim).conflicts.length === 0" class="empty small"><mat-icon>verified</mat-icon>暂无冲突，生效结果以先到确认为准。</p>
              <article *ngFor="let c of fund(claim).conflicts.slice().reverse()">
                <header><mat-icon>gavel</mat-icon><strong>{{ c.paymentNo }}</strong><span class="muted">{{ c.at }}</span></header>
                <p>{{ c.reason }}</p>
                <small>后到提交：{{ c.operator }} · {{ c.amount | currency:'CNY':'symbol':'1.0-0' }} · 账 {{ c.bankAccount || '—' }} · 记录号 {{ c.id }}</small>
              </article>
            </div>
          </section>

          <section class="panel" *ngIf="fund(claim).issues.length > 0">
            <div class="panel-head"><h3>对账问题</h3><span class="muted">{{ fund(claim).issues.length }} 项待核实</span></div>
            <div class="issue-list">
              <article *ngFor="let issue of fund(claim).issues.slice().reverse()">
                <mat-icon>{{ issue.kind === '超额回款' ? 'trending_up' : 'difference' }}</mat-icon>
                <div><strong>{{ issue.kind }} · {{ issue.amount | currency:'CNY':'symbol':'1.0-0' }}</strong><p>{{ issue.detail }}</p><small>{{ issue.at }} · {{ issue.id }}</small></div>
              </article>
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
    .metrics strong { display: block; margin: 7px 0; color: #153747; font-size: 24px; }
    .metrics .pay { color: #b5532a; }
    .metrics .recv { color: #1f7a5c; }
    .metrics .warn { color: #b95c2c; }
    .metrics .done { color: #1f7a5c; }
    .case-picker { width: 320px; }
    .ledger-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 14px; align-items: start; }
    .col { display: grid; gap: 14px; }
    aside { display: grid; gap: 14px; }
    .basis-list { padding: 14px 16px 16px; display: grid; gap: 12px; }
    .basis-list > article { border: 1px solid #dfe7ea; border-radius: 9px; padding: 13px 14px; background: #fbfcfd; }
    .basis-list > article.inactive { background: #f6f7f8; opacity: .82; }
    .basis-list header { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .basis-list header strong small { color: #8a979f; font-weight: 600; margin-left: 4px; }
    .basis-list header .muted { display: block; margin-top: 3px; font-size: 11px; }
    .basis-meta { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 8px; margin: 10px 0 6px; }
    .basis-meta span { display: block; color: #8a979f; font-size: 10px; }
    .basis-meta strong { font-size: 15px; color: #173f50; }
    .meta-line { margin: 4px 0 0; font-size: 11px; color: #6d7981; }
    .meta-line.void { color: #8a6b3f; }
    .meta-line.err { color: #b53c30; }
    .confirm-box { margin-top: 10px; padding: 12px; background: #eef6f7; border-left: 3px solid #2f8191; border-radius: 0 7px 7px 0; }
    .confirm-box.retry { background: #fff3ec; border-left-color: #ce743e; }
    .confirm-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .confirm-row mat-form-field { flex: 1; min-width: 150px; }
    .confirm-row .grow { flex: 1.6; }
    .confirm-actions { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
    .spacer { flex: 1; }
    .hint { margin: 8px 0 0; color: #77848c; font-size: 10px; }
    .empty { display: flex; align-items: center; gap: 8px; margin: 0; color: #77848c; font-size: 12px; }
    .empty.small { font-size: 11px; }
    .recovery-box { padding: 12px 16px 14px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; min-width: 520px; }
    td small { display: block; margin-top: 3px; color: #8a969e; font-size: 10px; }
    .amt-pay { color: #b5532a; font-weight: 700; white-space: nowrap; }
    .amt-recv { color: #1f7a5c; font-weight: 700; white-space: nowrap; }
    .void-tag { display: inline-block; margin-top: 4px; color: #9a7a44; }
    .voided-row td { text-decoration: line-through; text-decoration-color: #c3b39a; color: #98a3aa; }
    .voided-row .void-tag { text-decoration: none; }
    .conflict-list, .issue-list { padding: 10px 16px 14px; display: grid; gap: 10px; }
    .conflict-list article { padding: 10px 12px; background: #fff6ef; border: 1px solid #f3d9c6; border-radius: 8px; }
    .conflict-list header { display: flex; align-items: center; gap: 6px; }
    .conflict-list header mat-icon { color: #c16a34; font-size: 17px; width: 17px; height: 17px; }
    .conflict-list header span { margin-left: auto; font-size: 10px; }
    .conflict-list p { margin: 5px 0 3px; color: #7a4b2b; font-size: 11px; line-height: 1.5; }
    .conflict-list small { color: #98806c; font-size: 10px; }
    .issue-list article { display: flex; gap: 9px; padding: 9px 4px; border-bottom: 1px solid #eef1f3; }
    .issue-list mat-icon { color: #c19134; }
    .issue-list p { margin: 4px 0 0; color: #6d7981; font-size: 11px; line-height: 1.5; }
    .issue-list small { color: #98a3aa; font-size: 10px; }
    @media (max-width: 1150px) { .ledger-grid { grid-template-columns: 1fr; } .metrics { grid-template-columns: repeat(2,1fr); } }
  `],
})
export class LedgerPageComponent {
  claims$: Observable<ClaimCase[]>
  claim$: Observable<ClaimCase>
  entryColumns = ['at', 'type', 'summary', 'amount']

  operatorA = '王敏 / 支付岗'
  operatorB = '赵航 / 支付岗'
  amountA = 0
  accountA = '6222 8810 0021 7745'
  simulateFail = false
  busy = false

  recoveryType: '残值回收' | '追偿回款' = '残值回收'
  recoveryAmount = 0
  recoverySummary = ''

  diffAmount = 0
  diffDetail = ''

  constructor(
    private readonly store: Store<AppState>,
    private readonly service: ClaimsService,
    private readonly snackBar: MatSnackBar,
  ) {
    this.claims$ = this.store.select(selectAllClaims)
    this.claim$ = this.store.select(selectSelectedClaim)
  }

  fund(claim: ClaimCase): FundLedger {
    return ensureFund(claim)
  }

  totals(claim: ClaimCase) {
    return ledgerTotals(claim)
  }

  switchCase(id: string) {
    this.store.dispatch(selectClaim({ id }))
  }

  private patch(claim: ClaimCase, message: string) {
    this.store.dispatch(updateClaim({ claim: structuredClone(claim), toast: message }))
  }

  private errorMessage(err: unknown): string {
    return (err as { error?: { message?: string }; statusText?: string })?.error?.message ?? (err as { statusText?: string })?.statusText ?? '操作失败'
  }

  private prefillFromBasis(claim: ClaimCase, paymentNo: string) {
    const basis = ensureFund(claim).bases.find((item) => item.paymentNo === paymentNo)
    if (basis && !this.amountA) this.amountA = basis.amount
  }

  singleConfirm(claim: ClaimCase, paymentNo: string) {
    this.prefillFromBasis(claim, paymentNo)
    this.busy = true
    const token = `PAY-CFM-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    this.service
      .confirmPayment(claim.id, {
        operator: this.operatorA,
        amount: Number(this.amountA),
        bankAccount: this.accountA,
        simulateFailure: this.simulateFail,
        clientToken: token,
      })
      .subscribe({
        next: (updated) => {
          this.busy = false
          this.simulateFail = false
          this.patch(updated, '付款确认生效，垫付已入资金台账')
        },
        error: (err) => {
          this.busy = false
          this.simulateFail = false
          this.patch(claim, `付款确认未生效：${this.errorMessage(err)}`)
          this.service.get(claim.id).subscribe((updated) => this.store.dispatch(updateClaim({ claim: structuredClone(updated) })))
        },
      })
  }

  /** 两位支付岗同时点确认：并发同据，随机通道延迟，先到者生效，后到进冲突记录 */
  raceConfirm(claim: ClaimCase, paymentNo: string) {
    this.prefillFromBasis(claim, paymentNo)
    const amount = Number(this.amountA)
    this.busy = true
    const stamp = Date.now()
    const base = { amount, bankAccount: this.accountA, simulateFailure: false }
    const outcomes: Array<{ operator: string; ok: boolean; message: string }> = []
    let settled = 0
    const settle = () => {
      if (settled < 2) return
      this.busy = false
      const winner = outcomes.find((item) => item.ok)
      const loser = outcomes.find((item) => !item.ok)
      const message = winner
        ? `先到者（${winner.operator}）已生效${loser ? `；后到者（${loser.operator}）内容已留存冲突记录` : ''}`
        : `两份确认均未生效：${outcomes.map((item) => `${item.operator} ${item.message}`).join('；')}`
      this.service.get(claim.id).subscribe((updated) => this.store.dispatch(updateClaim({ claim: structuredClone(updated), toast: message })))
    }
    const send = (operator: string, token: string) =>
      this.service.confirmPayment(claim.id, { ...base, operator, clientToken: token }).subscribe({
        next: () => {
          outcomes.push({ operator, ok: true, message: '生效' })
          settled++
          settle()
        },
        error: (err) => {
          outcomes.push({ operator, ok: false, message: this.errorMessage(err) })
          settled++
          settle()
        },
      })
    send(this.operatorA, `RACE-A-${stamp}`)
    send(this.operatorB || '赵航 / 支付岗', `RACE-B-${stamp}`)
  }

  retry(claim: ClaimCase, paymentNo: string) {
    this.busy = true
    this.service.retryPayment(claim.id, paymentNo, { operator: this.operatorA, bankAccount: this.accountA, simulateFailure: this.simulateFail }).subscribe({
      next: (updated) => {
        this.busy = false
        this.simulateFail = false
        this.patch(updated, `原号 ${paymentNo} 重试成功，未重复记账`)
      },
      error: (err) => {
        this.busy = false
        this.simulateFail = false
        this.patch(claim, `重试未成功：${this.errorMessage(err)}`)
        this.service.get(claim.id).subscribe((updated) => this.store.dispatch(updateClaim({ claim: structuredClone(updated) })))
      },
    })
  }

  registerRecovery(claim: ClaimCase) {
    this.service
      .postRecovery(claim.id, { type: this.recoveryType, amount: Number(this.recoveryAmount), summary: this.recoverySummary, operator: '当前用户' })
      .subscribe((updated) => {
        this.patch(updated, `${this.recoveryType} ${Number(this.recoveryAmount).toLocaleString('zh-CN')} 元已冲减未结金额`)
        this.recoveryAmount = 0
        this.recoverySummary = ''
      })
  }

  registerDiff(claim: ClaimCase) {
    if (!this.diffDetail.trim()) return
    this.service.registerDiscrepancy(claim.id, { amount: Number(this.diffAmount), detail: this.diffDetail, operator: '当前用户' }).subscribe((updated) => {
      this.patch(updated, '对账差异已登记，原支付依据失效，准备金已重算')
      this.diffAmount = 0
      this.diffDetail = ''
    })
  }
}
