import assert from 'node:assert'
import {
  auditCoverage,
  normalizeCoverageTags,
} from '../src/lib/coverage'
import { planTagRename } from '../src/lib/rename'
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
  tags: string[],
  id?: string,
  status: Annotation['status'] = 'bound',
  quote?: string,
): Annotation {
  seq += 1
  return {
    id: id ?? `a${seq}`,
    quote: quote ?? '',
    start,
    end,
    note: '',
    tags,
    status,
    createdAt: 0,
    updatedAt: 0,
    contextBefore: '',
    contextAfter: '',
  }
}

function audit(
  ans: Annotation[],
  tags: string[],
  length = 20,
) {
  return auditCoverage(ans, length, tags)
}
function kinds(result: ReturnType<typeof audit>) {
  return result.issues.map((i) => [i.kind, i.start, i.end] as const)
}

// 1. 无选中标签：不产生任何问题
check('未选择标签时没有审计结果', () => {
  const r = audit([ann(0, 10, ['X'])], [])
  assert.strictEqual(r.issues.length, 0)
  assert.strictEqual(r.included.length, 0)
})

// 2. 完美覆盖：一条标注覆盖全文
check('单条标注恰好覆盖全文 → 无问题', () => {
  const r = audit([ann(0, 20, ['X'])], ['X'])
  assert.strictEqual(r.issues.length, 0)
  assert.strictEqual(r.coveredLength, 20)
})

// 3. 基本缺口：区间之外全部为缺口
check('区间之外是缺口（含起始前与结束后）', () => {
  const r = audit([ann(5, 15, ['X'])], ['X'])
  assert.deepStrictEqual(kinds(r), [
    ['gap', 0, 5],
    ['gap', 15, 20],
  ])
  assert.strictEqual(r.gapCount, 2)
  assert.strictEqual(r.gapLength, 10)
})

// 4. 基本重叠：两条命中标签的标注相交
check('两条命中标签的标注相交 → 交叠段为重叠', () => {
  const r = audit(
    [ann(0, 12, ['X'], 'a'), ann(8, 20, ['X'], 'b')],
    ['X'],
  )
  assert.deepStrictEqual(kinds(r), [['overlap', 8, 12]])
  assert.strictEqual(r.overlapCount, 1)
  assert.deepStrictEqual(r.issues[0].annotationIds, ['a', 'b'])
})

// 5. 相邻（端点相接，半开区间）不算重叠：[0,10) 与 [10,20) 恰好覆盖
check('端点相接不算重叠，且不产生缺口', () => {
  const r = audit(
    [ann(0, 10, ['X'], 'a'), ann(10, 20, ['X'], 'b')],
    ['X'],
  )
  assert.strictEqual(r.issues.length, 0)
  assert.strictEqual(r.coveredLength, 20)
})

// 6. pending 与空区间忽略
check('待处理标注与空区间不参与扫描', () => {
  const r = audit(
    [
      ann(0, 20, ['X'], 'p', 'pending'),
      ann(5, 5, ['X'], 'empty'),
    ],
    ['X'],
  )
  assert.strictEqual(r.included.length, 0)
  assert.deepStrictEqual(kinds(r), [['gap', 0, 20]])
})

// 7. 未命中所选标签的标注忽略（不产生覆盖）
check('未命中所选标签的标注不纳入，其区间仍为缺口', () => {
  const r = audit(
    [ann(0, 10, ['其他']), ann(5, 15, ['X'])],
    ['X'],
  )
  // 只有 X 标注纳入：[0,5) 缺口、[5,15) 覆盖一次、[15,20) 缺口
  assert.deepStrictEqual(kinds(r), [
    ['gap', 0, 5],
    ['gap', 15, 20],
  ])
})

// 8. 缺口合并：完全落在缺口内的未纳入标注的端点不应切碎缺口
check('缺口被未纳入标注分段后按参与集合合并', () => {
  // X 覆盖 [10,20)，未纳入标注 Y 完全位于 [2,8)
  // 分段点 0,2,8,10,20；gap 段 [0,2) [2,8) [8,10) 集合同为空 → 合并为 [0,10)
  const r = audit(
    [ann(10, 20, ['X']), ann(2, 8, ['Y'])],
    ['X'],
  )
  assert.deepStrictEqual(kinds(r), [['gap', 0, 10]])
})

// 9. 相邻重叠段：参与集合相同则合并（跨未纳入标注端点）
check('重叠合并：集合相同跨未纳入端点合并为一条', () => {
  // a=[0,20), b=[0,20) 全程 {a,b} 重叠；
  // 未纳入标注 c=[5,10) 会在 5/10 处分段，但集合始终 {a,b} → 合并为 [0,20)
  const r = audit(
    [
      ann(0, 20, ['X'], 'a'),
      ann(0, 20, ['X'], 'b'),
      ann(5, 10, ['Z'], 'c'),
    ],
    ['X'],
  )
  assert.strictEqual(r.overlapCount, 1)
  assert.deepStrictEqual(kinds(r), [['overlap', 0, 20]])
  assert.deepStrictEqual(r.issues[0].annotationIds, ['a', 'b'])
})

// 10. 重叠参与集合不同则不合并
check('相邻重叠段参与集合不同 → 保持多条', () => {
  const r = audit(
    [
      ann(0, 15, ['X'], 'a'),
      ann(5, 20, ['X'], 'b'),
      ann(10, 20, ['X'], 'c'),
    ],
    ['X'],
  )
  // [5,10){a,b} / [10,15){a,b,c} / [15,20){b,c}：三段集合均不同
  assert.deepStrictEqual(kinds(r), [
    ['overlap', 5, 10],
    ['overlap', 10, 15],
    ['overlap', 15, 20],
  ])
  assert.deepStrictEqual(r.issues[0].annotationIds, ['a', 'b'])
  assert.deepStrictEqual(r.issues[1].annotationIds, ['a', 'b', 'c'])
  assert.deepStrictEqual(r.issues[2].annotationIds, ['b', 'c'])
})

// 11. 类型不同不合并（覆盖一次的段把缺口与重叠隔开）
check('缺口与重叠不跨「恰好一次」段合并', () => {
  // a=[5,20), b=[10,15)：[0,5)缺口 / [5,10)一次 / [10,15)重叠 / [15,20)一次 / [20,..]无
  const r = audit(
    [ann(5, 20, ['X'], 'a'), ann(10, 15, ['X'], 'b')],
    ['X'],
    25,
  )
  assert.deepStrictEqual(kinds(r), [
    ['gap', 0, 5],
    ['overlap', 10, 15],
    ['gap', 20, 25],
  ])
})

// 12. 多标签选择：命中任一即纳入；同一条标注多标签不重复计数
check('多标签选择：命中任一纳入，同条标注只计一次', () => {
  const r = audit(
    [
      ann(0, 10, ['A', 'B'], 'a'),
      ann(5, 15, ['B'], 'b'),
    ],
    ['A', 'B'],
  )
  assert.deepStrictEqual(kinds(r), [
    ['overlap', 5, 10],
    ['gap', 15, 20],
  ])
  assert.deepStrictEqual(r.issues[0].annotationIds, ['a', 'b'])
})

// 13. 结果按起点排列，缺口与重叠混排
check('结果按起点升序排列', () => {
  const r = audit(
    [
      ann(0, 8, ['X'], 'a'),
      ann(2, 14, ['X'], 'b'),
      ann(18, 20, ['X'], 'c'),
    ],
    ['X'],
  )
  const starts = r.issues.map((i) => i.start)
  assert.deepStrictEqual(starts, [...starts].sort((x, y) => x - y))
  // [2,8) 重叠；[14,18) 缺口
  assert.deepStrictEqual(kinds(r), [
    ['overlap', 2, 8],
    ['gap', 14, 18],
  ])
})

// 14. marksByStart 标记问题段，覆盖一次的段不标记
check('marksByStart 仅标记缺口/重叠段', () => {
  const r = audit(
    [ann(5, 20, ['X'], 'a'), ann(10, 15, ['X'], 'b')],
    ['X'],
  )
  // 分段：[0,5)缺口 / [5,10)一次 / [10,15)重叠 / [15,20)一次（无 20 之后）
  assert.strictEqual(r.marksByStart.get(0), 'gap')
  assert.strictEqual(r.marksByStart.get(5), undefined) // 覆盖一次
  assert.strictEqual(r.marksByStart.get(10), 'overlap')
  assert.strictEqual(r.marksByStart.get(15), undefined) // 覆盖一次
})

// 15. 重叠结果携带参与标注详情
check('重叠结果附带参与标注详情（id/quote/tags）', () => {
  const r = audit(
    [ann(0, 10, ['X', 'Y'], 'a', 'bound', '引文A'), ann(5, 15, ['X'], 'b', 'bound', '引文B')],
    ['X'],
  )
  const ov = r.issues.find((i) => i.kind === 'overlap')!
  assert.strictEqual(ov.annotations.length, 2)
  assert.deepStrictEqual(ov.annotations.map((x) => x.quote), ['引文A', '引文B'])
  assert.deepStrictEqual(ov.annotations[0].tags, ['X', 'Y'])
})

// 16. normalizeCoverageTags：清洗、去 #、去重保序
check('normalizeCoverageTags：清洗去重保序', () => {
  assert.deepStrictEqual(
    normalizeCoverageTags([' A', '#A', ' B ', '', null, 'C']),
    ['A', 'B', 'C'],
  )
  assert.deepStrictEqual(normalizeCoverageTags('nope'), [])
  assert.deepStrictEqual(normalizeCoverageTags(undefined), [])
})

// 17. 空文本：无任何问题
check('空文本扫描不产生问题', () => {
  const r = audit([], [], 0)
  assert.strictEqual(r.issues.length, 0)
})

// 18. 标签重命名同步覆盖审计选择集
check('标签重命名同步覆盖标签集（保序去重）', () => {
  const plan = planTagRename(
    {
      annotations: [ann(0, 10, ['A', 'B'], 'a')],
      conflictRules: [],
      ignoredConflicts: [],
      coverageTags: ['A', 'B'],
    },
    'A',
    'B',
  )!
  // A→B 与已有 B 合并去重，保留靠前位置
  assert.deepStrictEqual(plan.coverageTags, ['B'])
})

// 19. 重命名为新标签时覆盖集合跟随更新，审计语义不变
check('重命名为新标签后覆盖集合跟随更新', () => {
  const ans = [ann(0, 20, ['旧名'], 'a')]
  const before = audit(ans, ['旧名'])
  assert.strictEqual(before.issues.length, 0)
  const plan = planTagRename(
    { annotations: ans, conflictRules: [], ignoredConflicts: [], coverageTags: ['旧名'] },
    '旧名',
    '新名',
  )!
  assert.deepStrictEqual(plan.coverageTags, ['新名'])
  const after = audit(plan.annotations, plan.coverageTags)
  assert.strictEqual(after.issues.length, 0)
  assert.strictEqual(after.coveredLength, 20)
})

// 20. 三层覆盖：只报 >1，参与集合按实际叠加给出
check('三层叠加：集合随叠加数变化分段', () => {
  const r = audit(
    [
      ann(0, 15, ['X'], 'a'),
      ann(5, 20, ['X'], 'b'),
      ann(10, 20, ['X'], 'c'),
    ],
    ['X'],
  )
  // [5,10){a,b} / [10,15){a,b,c} / [15,20){b,c} 三个重叠
  assert.strictEqual(r.overlapCount, 3)
  assert.strictEqual(r.issues[1].annotationIds.length, 3)
})

console.log(`\n全部 ${passed} 项通过`)
