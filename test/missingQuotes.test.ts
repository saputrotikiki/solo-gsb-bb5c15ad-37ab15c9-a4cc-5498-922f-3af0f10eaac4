import assert from 'node:assert'
import {
  auditQuoteOccurrences,
  findQuoteOccurrences,
  planQuoteBackfill,
} from '../src/lib/missingQuotes'
import { CONTEXT_RADIUS } from '../src/lib/relocation'
import type { Annotation } from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let seq = 0
function ann(
  start: number,
  end: number,
  id?: string,
  opts: Partial<Annotation> = {},
): Annotation {
  seq += 1
  return {
    id: id ?? `a${seq}`,
    quote: '',
    start,
    end,
    note: '',
    tags: [],
    status: 'bound',
    createdAt: 0,
    updatedAt: 0,
    contextBefore: '',
    contextAfter: '',
    ...opts,
  }
}

// 1. 精确出现枚举：含重叠
check('枚举全部精确出现位置（含重叠）', () => {
  assert.deepStrictEqual(findQuoteOccurrences('aaaa', 'aa'), [0, 1, 2])
  assert.deepStrictEqual(findQuoteOccurrences('甲乙丙甲乙丁甲乙', '甲乙'), [0, 3, 6])
  assert.deepStrictEqual(findQuoteOccurrences('abcabc', 'abcabc'), [0])
})

// 2. 空引文 / 未出现
check('空引文返回空；未出现返回空', () => {
  assert.deepStrictEqual(findQuoteOccurrences('abc', ''), [])
  assert.deepStrictEqual(findQuoteOccurrences('', '甲'), [])
  assert.deepStrictEqual(findQuoteOccurrences('abc', 'Z'), [])
})

const text = '甲乙丙甲乙丁甲乙' // 「甲乙」出现在 0、3、6

// 3. 审计：仅起止完全相同的已绑定标注算已标注
check('审计：起止完全相同的已绑定标注才算已标注', () => {
  const anns = [
    ann(0, 2, 'tpl', { quote: '甲乙', tags: ['重点'], note: '模板备注' }),
    ann(3, 5, 'p1', { status: 'pending', quote: '甲乙' }), // 待处理不算
    ann(2, 4, 'b2', { quote: '丙甲' }), // 区间不同不算
  ]
  const audit = auditQuoteOccurrences(text, anns, 'tpl')!
  assert.ok(audit)
  assert.strictEqual(audit.quote, '甲乙')
  assert.deepStrictEqual(
    audit.occurrences.map((o) => [o.start, o.end, o.covered]),
    [
      [0, 2, true],
      [3, 5, false], // 待处理同区间不算已标注
      [6, 8, false],
    ],
  )
  assert.strictEqual(audit.coveredCount, 1)
  assert.strictEqual(audit.missingCount, 2)
})

// 4. 模板失效：不存在 / 待处理 / 空引文 → null
check('模板不存在、待处理或引文为空时审计返回 null', () => {
  const anns = [ann(0, 2, 'tpl', { quote: '甲乙' })]
  assert.strictEqual(auditQuoteOccurrences(text, anns, 'ghost'), null)
  assert.strictEqual(
    auditQuoteOccurrences(text, [ann(0, 2, 'tpl', { quote: '甲乙', status: 'pending' })], 'tpl'),
    null,
  )
  assert.strictEqual(
    auditQuoteOccurrences(text, [ann(0, 0, 'tpl', { quote: '' })], 'tpl'),
    null,
  )
})

// 5. 补建：复制模板标签与备注，按各位置重新截取上下文
check('补建：复制模板标签与备注，各位置重新截取锚点上下文', () => {
  const anns = [ann(0, 2, 'tpl', { quote: '甲乙', tags: ['重点', '甲'], note: '备注X' })]
  const plan = planQuoteBackfill(text, anns, 'tpl', [
    { start: 3, end: 5 },
    { start: 6, end: 8 },
  ], 1000)!
  assert.strictEqual(plan.created.length, 2)
  assert.strictEqual(plan.skippedCount, 0)
  const [c1, c2] = plan.created
  assert.strictEqual(c1.quote, '甲乙')
  assert.strictEqual(c1.start, 3)
  assert.strictEqual(c1.end, 5)
  assert.deepStrictEqual(c1.tags, ['重点', '甲'])
  assert.strictEqual(c1.note, '备注X')
  assert.strictEqual(c1.status, 'bound')
  assert.strictEqual(c1.createdAt, 1000)
  assert.strictEqual(c1.updatedAt, 1000)
  // 上下文按新位置截取（半径 CONTEXT_RADIUS 内）
  assert.strictEqual(c1.contextBefore, text.slice(Math.max(0, 3 - CONTEXT_RADIUS), 3))
  assert.strictEqual(c1.contextAfter, text.slice(5, Math.min(text.length, 5 + CONTEXT_RADIUS)))
  assert.strictEqual(c2.contextBefore, text.slice(Math.max(0, 6 - CONTEXT_RADIUS), 6))
  // 标签是拷贝而非引用
  c1.tags.push('改动')
  assert.deepStrictEqual(anns[0].tags, ['重点', '甲'])
  // 新标注追加在末尾，原标注顺序与引用不变
  assert.strictEqual(plan.annotations.length, 3)
  assert.strictEqual(plan.annotations[0], anns[0])
  assert.ok(plan.created.every((a) => a.id.startsWith('a_')))
  assert.notStrictEqual(c1.id, c2.id)
})

// 6. 提交时重新核对：已补过的位置跳过（含同批重复勾选）
check('提交核对：起止相同的已绑定标注已存在则跳过；重复勾选只补一次', () => {
  const anns = [
    ann(0, 2, 'tpl', { quote: '甲乙' }),
    ann(3, 5, 'other', { quote: '甲乙' }), // 已被补过
  ]
  const plan = planQuoteBackfill(text, anns, 'tpl', [
    { start: 3, end: 5 }, // 已补过 → 跳过
    { start: 6, end: 8 },
    { start: 6, end: 8 }, // 重复勾选 → 静默去重，不计跳过
  ])!
  assert.strictEqual(plan.created.length, 1)
  assert.strictEqual(plan.created[0].start, 6)
  assert.strictEqual(plan.skippedCount, 1)
})

// 7. 提交时重新核对：位置已变化（原文不再是引文精确出现）跳过
check('提交核对：位置已变化或越界则跳过', () => {
  const anns = [ann(0, 2, 'tpl', { quote: '甲乙' })]
  const changed = '甲乙丙XX丁甲乙' // [3,5) 已不再是「甲乙」
  const plan = planQuoteBackfill(changed, anns, 'tpl', [
    { start: 3, end: 5 }, // 已变化 → 跳过
    { start: 6, end: 8 }, // 仍是「甲乙」→ 补建
    { start: -1, end: 1 }, // 越界 → 跳过
    { start: 6, end: 100 }, // 越界 → 跳过
  ])!
  assert.strictEqual(plan.created.length, 1)
  assert.strictEqual(plan.created[0].start, 6)
  assert.strictEqual(plan.skippedCount, 3)
})

// 8. 模板失效时整体返回 null，不落地任何变更
check('模板失效时计划返回 null', () => {
  const anns = [ann(0, 2, 'tpl', { quote: '甲乙', status: 'pending' })]
  assert.strictEqual(planQuoteBackfill(text, anns, 'tpl', [{ start: 3, end: 5 }]), null)
  assert.strictEqual(planQuoteBackfill(text, [], 'ghost', [{ start: 3, end: 5 }]), null)
})

// 9. 端到端：审计 → 补建 → 再审计漏标清零
check('端到端：补建后再次审计漏标清零', () => {
  const anns = [ann(0, 2, 'tpl', { quote: '甲乙', tags: ['重点'] })]
  const before = auditQuoteOccurrences(text, anns, 'tpl')!
  assert.strictEqual(before.missingCount, 2)
  const positions = before.occurrences
    .filter((o) => !o.covered)
    .map((o) => ({ start: o.start, end: o.end }))
  const plan = planQuoteBackfill(text, anns, 'tpl', positions)!
  const after = auditQuoteOccurrences(text, plan.annotations, 'tpl')!
  assert.strictEqual(after.missingCount, 0)
  assert.strictEqual(after.coveredCount, 3)
  // 再次提交相同位置：全部已补过 → 全部跳过
  const again = planQuoteBackfill(text, plan.annotations, 'tpl', positions)!
  assert.strictEqual(again.created.length, 0)
  assert.strictEqual(again.skippedCount, 2)
})

// 10. 重叠出现位置可分别补建
check('重叠出现位置可分别补建', () => {
  const t = 'aaaa'
  const anns = [ann(0, 2, 'tpl', { quote: 'aa' })]
  const audit = auditQuoteOccurrences(t, anns, 'tpl')!
  assert.deepStrictEqual(
    audit.occurrences.map((o) => [o.start, o.covered]),
    [
      [0, true],
      [1, false],
      [2, false],
    ],
  )
  const plan = planQuoteBackfill(t, anns, 'tpl', [
    { start: 1, end: 3 },
    { start: 2, end: 4 },
  ])!
  assert.strictEqual(plan.created.length, 2)
  assert.strictEqual(auditQuoteOccurrences(t, plan.annotations, 'tpl')!.missingCount, 0)
})

console.log(`\nmissingQuotes：${passed} 项断言全部通过`)
