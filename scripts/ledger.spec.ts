import assert from 'node:assert'
import { seedClaims } from '../src/app/core/seed'
import {
  activeBasis,
  confirmPayment,
  createPendingBasis,
  ensureFund,
  invalidateBasis,
  ledgerTotals,
  postRecovery,
  recomputeReserve,
  registerDiscrepancy,
  retryPayment,
} from '../src/app/core/ledger'
import type { ClaimCase } from '../src/app/core/models'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

function freshClaim(): ClaimCase {
  return structuredClone(seedClaims[0])
}

/** 会签全部通过 → 自动立据 */
function approvedClaim(): ClaimCase {
  const claim = freshClaim()
  claim.approvals.forEach((step) => {
    step.status = '已通过'
    step.operator = '测试'
  })
  createPendingBasis(claim)
  return claim
}

console.log('1) 会签 → 唯一支付依据')
check('全部会签通过后生成一份待生效依据，金额=准备金', () => {
  const claim = approvedClaim()
  const basis = activeBasis(claim)
  assert.ok(basis)
  assert.equal(basis!.status, '待生效')
  assert.equal(basis!.amount, claim.reserve)
  assert.equal(claim.status, '待支付')
})

check('重复立据不会产生第二份依据', () => {
  const claim = approvedClaim()
  assert.equal(createPendingBasis(claim), null)
  assert.equal(ensureFund(claim).bases.length, 1)
})

console.log('\n2) 双人同时付款确认：先到生效，后到进冲突')
check('两次确认：先到者生效记账，后到者 409 且入冲突记录，不重复记账', () => {
  const claim = approvedClaim()
  const paymentNo = activeBasis(claim)!.paymentNo
  const r1 = confirmPayment(claim, { operator: '甲', amount: claim.reserve, bankAccount: 'A', clientToken: 't1' })
  const r2 = confirmPayment(claim, { operator: '乙', amount: claim.reserve, bankAccount: 'B', clientToken: 't2' })
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, false)
  assert.equal((r2 as { status: number }).status, 409)
  const fund = ensureFund(claim)
  assert.equal(fund.entries.filter((e) => e.type === '垫付').length, 1)
  assert.equal(fund.conflicts.length, 1)
  assert.equal(fund.conflicts[0].operator, '乙')
  assert.equal(fund.conflicts[0].paymentNo, paymentNo)
  assert.equal(activeBasis(claim)!.status, '已生效')
  assert.equal(ledgerTotals(claim).paid, claim.reserve)
})

check('依据待生效时金额不一致的确认进冲突记录，依据仍待生效', () => {
  const claim = approvedClaim()
  const r = confirmPayment(claim, { operator: '丙', amount: claim.reserve - 1, bankAccount: 'C' })
  assert.equal(r.ok, false)
  assert.equal(ensureFund(claim).conflicts.length, 1)
  assert.match(ensureFund(claim).conflicts[0].reason, /不一致/)
  assert.equal(activeBasis(claim)!.status, '待生效')
})

check('同 clientToken 重复提交幂等返回，不产生第二条流水/冲突', () => {
  const claim = approvedClaim()
  const body = { operator: '甲', amount: claim.reserve, bankAccount: 'A', clientToken: 'same-token' }
  assert.equal(confirmPayment(claim, body).ok, true)
  const again = confirmPayment(claim, body)
  assert.equal(again.ok, true)
  const fund = ensureFund(claim)
  assert.equal(fund.entries.length, 1)
  assert.equal(fund.conflicts.length, 0)
})

console.log('\n3) 回款到账冲减未结')
check('残值回收与追偿回款分别冲减未结，归零后结案', () => {
  const claim = approvedClaim()
  confirmPayment(claim, { operator: '甲', amount: claim.reserve, bankAccount: 'A' })
  assert.equal(postRecovery(claim, { type: '残值回收', amount: 50000, summary: '旧设备残值', operator: '回收岗' }).ok, true)
  assert.equal(ledgerTotals(claim).recovered, 50000)
  assert.equal(ledgerTotals(claim).outstanding, claim.reserve - 50000)
  const left = ledgerTotals(claim).outstanding
  assert.equal(postRecovery(claim, { type: '追偿回款', amount: left, summary: '责任方追偿', operator: '法务岗' }).ok, true)
  assert.equal(ledgerTotals(claim).outstanding, 0)
  assert.equal(claim.status, '已结案')
})

check('回款超过生效垫付 → 未结保持 0 并登记超额问题', () => {
  const claim = approvedClaim()
  const basis = activeBasis(claim)!
  basis.amount = 1000 // 模拟小额依据验证超额逻辑
  confirmPayment(claim, { operator: '甲', amount: 1000, bankAccount: 'A' })
  postRecovery(claim, { type: '追偿回款', amount: 1200, summary: '多付', operator: '法务岗' })
  const totals = ledgerTotals(claim)
  assert.equal(totals.outstanding, 0)
  assert.equal(totals.overRecovered, true)
  assert.equal(ensureFund(claim).issues.some((i) => i.kind === '超额回款'), true)
})

console.log('\n4) 金额改动 / 对账差异 → 原支付失效 + 准备金重算')
check('改价使生效依据失效：垫付红冲留痕、准备金重算、会签重置', () => {
  const claim = approvedClaim()
  confirmPayment(claim, { operator: '甲', amount: claim.reserve, bankAccount: 'A' })
  const item = claim.lossItems[0]
  item.repairQuotes.push({ version: 9, amount: item.repairQuotes.at(-1)!.amount + 100000, reason: '新增隐蔽损失', operator: '测试', createdAt: 'now' })
  const expectedReserve = recomputeReserve(claim)
  invalidateBasis(claim, '报价调整')
  assert.equal(activeBasis(claim), undefined)
  assert.equal(ensureFund(claim).bases[0].status, '已失效')
  assert.equal(ledgerTotals(claim).paid, 0, '垫付已红冲，不计入已付')
  assert.equal(ensureFund(claim).entries.find((e) => e.type === '垫付')!.entryStatus, '已冲销')
  assert.equal(claim.reserve, expectedReserve)
  assert.equal(claim.status, '待复核')
  assert.ok(claim.approvals.every((s) => s.threshold === 0 || s.status === '待处理'))
})

check('重新会签后生成 V2 新支付号，原失效依据与流水仍可追溯', () => {
  const claim = approvedClaim()
  const oldNo = activeBasis(claim)!.paymentNo
  confirmPayment(claim, { operator: '甲', amount: claim.reserve, bankAccount: 'A' })
  invalidateBasis(claim, '对账差异')
  claim.approvals.forEach((s) => (s.status = '已通过'))
  createPendingBasis(claim)
  const basis = activeBasis(claim)!
  assert.equal(basis.version, 2)
  assert.notEqual(basis.paymentNo, oldNo)
  assert.equal(ensureFund(claim).bases.length, 2)
})

check('登记对账差异：依据失效、差异调整留痕、准备金重算', () => {
  const claim = approvedClaim()
  confirmPayment(claim, { operator: '甲', amount: claim.reserve, bankAccount: 'A' })
  const r = registerDiscrepancy(claim, { amount: -30000, detail: '银行对账短款 3 万', operator: '财务岗' })
  assert.equal(r.ok, true)
  const fund = ensureFund(claim)
  assert.equal(fund.issues.some((i) => i.kind === '对账差异' && i.detail.includes('短款')), true)
  assert.equal(fund.entries.some((e) => e.type === '对账差异'), true)
  assert.equal(fund.bases[0].status, '已失效')
  assert.equal(claim.status, '待复核')
})

check('差异说明必填', () => {
  const claim = approvedClaim()
  const r = registerDiscrepancy(claim, { amount: 1, detail: '', operator: '财务岗' })
  assert.equal(r.ok, false)
})

console.log('\n5) 失败按原号重试，不重复记账')
check('模拟失败 → 依据置支付失败；原号重试成功后仅一笔垫付', () => {
  const claim = approvedClaim()
  const paymentNo = activeBasis(claim)!.paymentNo
  const fail = confirmPayment(claim, { operator: '甲', amount: claim.reserve, bankAccount: 'A', simulateFailure: true })
  assert.equal(fail.ok, false)
  assert.equal((fail as { status: number }).status, 502)
  assert.equal(activeBasis(claim)!.status, '支付失败')
  assert.equal(ensureFund(claim).entries.filter((e) => e.type === '垫付').length, 0)
  const retry = retryPayment(claim, paymentNo, { operator: '甲', bankAccount: 'A' })
  assert.equal(retry.ok, true)
  assert.equal(activeBasis(claim)!.status, '已生效')
  assert.equal(activeBasis(claim)!.attempts, 2)
  assert.equal(ensureFund(claim).bases.length, 1, '仍是同一支付号/依据')
  assert.equal(ensureFund(claim).entries.filter((e) => e.type === '垫付' && e.entryStatus === '正常').length, 1)
})

check('已生效支付号再重试 → 409 拒绝，不重复记账', () => {
  const claim = approvedClaim()
  const no = activeBasis(claim)!.paymentNo
  confirmPayment(claim, { operator: '甲', amount: claim.reserve, bankAccount: 'A' })
  const r = retryPayment(claim, no, { operator: '乙', bankAccount: 'B' })
  assert.equal(r.ok, false)
  assert.equal((r as { status: number }).status, 409)
  assert.equal(ensureFund(claim).entries.filter((e) => e.type === '垫付').length, 1)
})

check('失效支付号不能重试，需重新会签', () => {
  const claim = approvedClaim()
  const no = activeBasis(claim)!.paymentNo
  confirmPayment(claim, { operator: '甲', amount: claim.reserve, bankAccount: 'A' })
  invalidateBasis(claim, '金额改动')
  const r = retryPayment(claim, no, { operator: '甲', bankAccount: 'A' })
  assert.equal(r.ok, false)
  assert.match((r as { error: string }).error, /失效/)
})

console.log(`\n全部 ${passed} 项断言通过 ✅`)
