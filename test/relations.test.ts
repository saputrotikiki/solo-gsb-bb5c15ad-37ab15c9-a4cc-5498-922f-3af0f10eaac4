import assert from 'node:assert'
import {
  auditRelationCardinality,
  buildRelationViews,
  CARDINALITY_SIDE_LABEL,
  cardinalityLimitText,
  isSelfRelation,
  normalizeCardinalityRules,
  normalizeRelations,
  relationKey,
  relationStats,
  relationTypeFilters,
  sortRelationViews,
  RELATION_INVALID_REASON_LABEL,
} from '../src/lib/relations'
import type {
  Annotation,
  AnnotationRelation,
  RelationCardinalityRule,
} from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let seq = 0
function ann(
  id: string,
  status: Annotation['status'] = 'bound',
  start = 0,
): Annotation {
  seq += 1
  return {
    id,
    quote: `引文-${id}`,
    start,
    end: start + 2,
    note: '',
    tags: [],
    status,
    createdAt: seq,
    updatedAt: seq,
    contextBefore: '',
    contextAfter: '',
  }
}

function rel(
  sourceId: string,
  targetId: string,
  type = '支撑',
  createdAt = 1,
  id?: string,
): AnnotationRelation {
  return { id: id ?? `rel_${sourceId}_${targetId}_${type}`, sourceId, targetId, type, createdAt }
}

// 1. 约束判定：自关联键与完全重复键
check('自关联判定', () => {
  assert.strictEqual(isSelfRelation('a', 'a'), true)
  assert.strictEqual(isSelfRelation('a', 'b'), false)
  assert.strictEqual(isSelfRelation('', ''), false)
})

check('完全重复键方向敏感：A→B 与 B→A 不是重复', () => {
  assert.strictEqual(relationKey('a', 'b', '支撑'), relationKey('a', 'b', '支撑'))
  assert.notStrictEqual(relationKey('a', 'b', '支撑'), relationKey('b', 'a', '支撑'))
  assert.notStrictEqual(relationKey('a', 'b', '支撑'), relationKey('a', 'b', '反驳'))
})

// 2. normalizeRelations：旧版缺省 / 非法输入按空；丢弃自关联与缺字段；完全重复保留最早一条
check('清洗：非数组 / null / 旧版缺省按空数组', () => {
  assert.deepStrictEqual(normalizeRelations(undefined), [])
  assert.deepStrictEqual(normalizeRelations(null), [])
  assert.deepStrictEqual(normalizeRelations('x'), [])
  assert.deepStrictEqual(normalizeRelations({}), [])
})

check('清洗：自关联与字段缺失丢弃；类型去首尾空白；时间字符串解析', () => {
  const out = normalizeRelations([
    { id: 'r1', sourceId: 'a', targetId: 'a', type: '自环', createdAt: 1 },
    { sourceId: 'a', targetId: 'b', type: '支撑', createdAt: '2026-09-18T00:00:00.000Z' },
    { sourceId: 'a', targetId: '', type: '支撑' },
    { sourceId: 'a', targetId: 'b', type: '   ' },
    null,
    { sourceId: 2 as unknown as string, targetId: 'b', type: '支撑' },
  ])
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].sourceId, 'a')
  assert.strictEqual(out[0].targetId, 'b')
  assert.strictEqual(out[0].type, '支撑')
  assert.strictEqual(out[0].createdAt, Date.parse('2026-09-18T00:00:00.000Z'))
})

check('清洗：完全重复（源+目标+类型）只保留第一条；反向关系保留；不同类型保留', () => {
  const out = normalizeRelations([
    rel('a', 'b', '支撑', 10, 'r1'),
    rel('a', 'b', '支撑', 5, 'r2'), // 完全重复 → 丢弃
    rel('b', 'a', '支撑', 5, 'r3'), // 反向 → 保留
    rel('a', 'b', '反驳', 5, 'r4'), // 不同类型 → 保留
  ])
  assert.deepStrictEqual(out.map((r) => r.id), ['r1', 'r3', 'r4'])
})

// 3. 有效性派生：两端存在且已绑定才有效；删除 / pending 标原因；重绑恢复
check('派生视图：两端已绑定 → 有效', () => {
  const ans = [ann('a'), ann('b')]
  const views = buildRelationViews([rel('a', 'b')], ans)
  assert.strictEqual(views.length, 1)
  assert.strictEqual(views[0].active, true)
  assert.strictEqual(views[0].invalidReason, null)
  assert.strictEqual(views[0].source?.id, 'a')
  assert.strictEqual(views[0].target?.id, 'b')
})

check('派生视图：源/目标进入待处理 → 对应失效原因', () => {
  const ans = [ann('a', 'pending'), ann('b')]
  const views = buildRelationViews([rel('a', 'b'), rel('b', 'a')], ans)
  assert.strictEqual(views[0].active, false)
  assert.strictEqual(views[0].invalidReason, 'source-pending')
  assert.strictEqual(views[1].active, false)
  assert.strictEqual(views[1].invalidReason, 'target-pending')
  const both = buildRelationViews([rel('a', 'b')], [ann('a', 'pending'), ann('b', 'pending')])
  assert.strictEqual(both[0].invalidReason, 'both-pending')
})

check('派生视图：源/目标被删除（标注不存在）→ missing；两端都删 → both-missing', () => {
  const one = buildRelationViews([rel('a', 'b'), rel('a', 'c')], [ann('b')])
  assert.strictEqual(one[0].invalidReason, 'source-missing')
  assert.strictEqual(one[0].active, false)
  assert.strictEqual(one[1].invalidReason, 'both-missing')
  assert.strictEqual(one[1].source, null)
  assert.strictEqual(one[1].target, null)
})

check('重新绑定后自动恢复：同一份关系数据，pending → bound 后视图变为有效', () => {
  const relation = rel('a', 'b')
  const pendingViews = buildRelationViews([relation], [ann('a', 'pending'), ann('b')])
  assert.strictEqual(pendingViews[0].active, false)
  const reboundViews = buildRelationViews([relation], [ann('a', 'bound'), ann('b')])
  assert.strictEqual(reboundViews[0].active, true)
  assert.strictEqual(reboundViews[0].relation, relation, '关系记录本身不被修改')
})

// 4. 统计
check('统计：有效 / 失效 / 总数', () => {
  const ans = [ann('a'), ann('b', 'pending')]
  const views = buildRelationViews(
    [rel('a', 'b'), rel('b', 'a'), rel('x', 'a')],
    ans,
  )
  const stats = relationStats(views)
  assert.deepStrictEqual(stats, { total: 3, active: 0, invalid: 3 })
  const stats2 = relationStats(buildRelationViews([rel('a', 'b')], [ann('a'), ann('b')]))
  assert.deepStrictEqual(stats2, { total: 1, active: 1, invalid: 0 })
})

// 5. 排序：有效在前（源起点），失效在后（创建时间新→旧）
check('排序：有效在前按源起点，失效在后按创建时间', () => {
  const ans = [
    ann('a', 'bound', 10),
    ann('b', 'bound', 2),
    ann('p', 'pending', 0),
  ]
  const views = buildRelationViews(
    [
      rel('a', 'b', '支撑', 100, 'r_far'),
      rel('b', 'a', '支撑', 100, 'r_near'), // 源起点 2 更靠前
      rel('p', 'a', '支撑', 50, 'r_old_invalid'),
      rel('p', 'b', '反驳', 90, 'r_new_invalid'),
    ],
    ans,
  )
  const ids = sortRelationViews(views).map((v) => v.relation.id)
  assert.deepStrictEqual(ids, ['r_near', 'r_far', 'r_new_invalid', 'r_old_invalid'])
})

// 6. 类型筛选列表：按最早出现时间排序
check('类型筛选项：按该类型最早一条关系的创建时间排序', () => {
  const types = relationTypeFilters([
    rel('a', 'b', '晚出现', 30),
    rel('a', 'c', '早出现', 10),
    rel('a', 'd', '早出现', 40),
  ])
  assert.deepStrictEqual(types, ['早出现', '晚出现'])
  assert.deepStrictEqual(relationTypeFilters([]), [])
})

// 7. 失效原因标签齐全（报告与侧栏共用）
check('全部失效原因都有中文标签', () => {
  for (const reason of [
    'source-missing',
    'target-missing',
    'both-missing',
    'source-pending',
    'target-pending',
    'both-pending',
  ] as const) {
    assert.ok(RELATION_INVALID_REASON_LABEL[reason].length > 0)
  }
})

// 8. 基数上限规则清洗
function capRule(
  type: string,
  maxOut: number | null,
  maxIn: number | null,
  createdAt = 1,
  id?: string,
): RelationCardinalityRule {
  return { id: id ?? `cap_${type}`, type, maxOut, maxIn, createdAt }
}

check('基数规则清洗：非数组 / 旧版缺省按空数组', () => {
  assert.deepStrictEqual(normalizeCardinalityRules(undefined), [])
  assert.deepStrictEqual(normalizeCardinalityRules(null), [])
  assert.deepStrictEqual(normalizeCardinalityRules('x'), [])
  assert.deepStrictEqual(normalizeCardinalityRules({}), [])
})

check('基数规则清洗：丢弃空类型与两个名额都为空的条目；非法名额按 null', () => {
  const out = normalizeCardinalityRules([
    { id: 'c1', type: ' 支撑 ', maxOut: '2', maxIn: 3, createdAt: 5 },
    { id: 'c2', type: '', maxOut: 1, maxIn: 1 },
    { id: 'c3', type: '反驳', maxOut: null, maxIn: null },
    { id: 'c4', type: '引用', maxOut: 0, maxIn: 1.5 },
    { id: 'c5', type: '属于', maxOut: '', maxIn: '1' },
    null,
  ])
  assert.deepStrictEqual(
    out.map((r) => [r.type, r.maxOut, r.maxIn]),
    [
      ['支撑', 2, 3],
      ['属于', null, 1],
    ],
  )
  assert.strictEqual(out[0].id, 'c1')
  assert.strictEqual(out[0].createdAt, 5)
})

check('基数规则清洗：同类型只保留最早一条；结果按创建时间排序', () => {
  const out = normalizeCardinalityRules([
    capRule('支撑', 2, null, 20, 'c_late'),
    capRule('支撑', 1, 1, 10, 'c_early'),
    capRule('反驳', 1, null, 30, 'c_ref'),
  ])
  assert.deepStrictEqual(out.map((r) => r.id), ['c_early', 'c_ref'])
  assert.deepStrictEqual(out[0], { id: 'c_early', type: '支撑', maxOut: 1, maxIn: 1, createdAt: 10 })
})

// 9. 基数上限审计
function capViews(rels: AnnotationRelation[], ans: Annotation[] = []) {
  const defaults = new Set<string>()
  rels.forEach((r) => {
    defaults.add(r.sourceId)
    defaults.add(r.targetId)
  })
  const all = [...ans]
  for (const id of defaults) {
    if (!all.some((a) => a.id === id)) all.push(ann(id, 'bound', id.charCodeAt(1) ?? 0))
  }
  return buildRelationViews(rels, all)
}

check('审计：无规则时无违规；留空方向不限制', () => {
  const views = capViews([
    rel('a', 'b', '支撑', 1, 'r1'),
    rel('a', 'c', '支撑', 2, 'r2'),
    rel('a', 'd', '支撑', 3, 'r3'),
  ])
  assert.strictEqual(auditRelationCardinality(views, []).count, 0)
  // 只配 maxIn：出边再多也不违规
  const rules = [capRule('支撑', null, 5)]
  assert.strictEqual(auditRelationCardinality(views, rules).count, 0)
})

check('审计：maxOut=1 时同一源的第 2、3 条出边为源端违规，按创建时间决胜', () => {
  const views = capViews([
    rel('a', 'b', '支撑', 30, 'r_late'),
    rel('a', 'c', '支撑', 10, 'r_early'),
    rel('a', 'd', '支撑', 20, 'r_mid'),
  ])
  const audit = auditRelationCardinality(views, [capRule('支撑', 1, null)])
  assert.deepStrictEqual(
    audit.violations.map((v) => v.view.relation.id),
    ['r_mid', 'r_late'],
    '违规按创建时间（再按 ID）升序输出',
  )
  assert.ok(audit.violations.every((v) => v.side === 'source'))
  assert.strictEqual(audit.sourceOverCount, 2)
  assert.strictEqual(audit.targetOverCount, 0)
  // 不同源各自计数
  const mixed = capViews([
    rel('a', 'b', '支撑', 1, 'm1'),
    rel('a', 'c', '支撑', 2, 'm2'),
    rel('x', 'y', '支撑', 3, 'm3'),
  ])
  assert.strictEqual(auditRelationCardinality(mixed, [capRule('支撑', 1, null)]).count, 1)
})

check('审计：maxIn 按目标入边；类型不同互不影响', () => {
  const views = capViews([
    rel('a', 't', '支撑', 1, 'i1'),
    rel('b', 't', '支撑', 2, 'i2'),
    rel('c', 't', '反驳', 3, 'i3'),
    rel('d', 't', '反驳', 4, 'i4'),
  ])
  const audit = auditRelationCardinality(
    views,
    [capRule('支撑', null, 1), capRule('反驳', null, 1)],
  )
  assert.deepStrictEqual(
    audit.violations.map((v) => v.view.relation.id).sort(),
    ['i2', 'i4'],
  )
  assert.ok(audit.violations.every((v) => v.side === 'target'))
})

check('审计：同一条关系源端与目标端都超限时记为 both 且只算一条', () => {
  // a 的出边桶：earlyOut(更早) 占名额 → both1 / out1 源端超限；
  // b 的入边桶：earlyIn(更早) 占名额 → both1 / in1 目标端超限；
  // 公共关系 both1 两端都超限 → both；它是第 2 条出边、第 2 条入边。
  const views = capViews([
    rel('a', 'x', '支撑', 1, 'earlyOut'),
    rel('y', 'b', '支撑', 2, 'earlyIn'),
    rel('a', 'b', '支撑', 3, 'both1'),
    rel('a', 'c', '支撑', 4, 'out1'),
    rel('d', 'b', '支撑', 5, 'in1'),
  ])
  const audit = auditRelationCardinality(views, [capRule('支撑', 1, 1)])
  assert.strictEqual(audit.count, 3, 'both1 / out1 / in1 三条违规')
  assert.strictEqual(audit.sourceOverCount, 2)
  assert.strictEqual(audit.targetOverCount, 2)
  const both = audit.violations.find((v) => v.view.relation.id === 'both1')!
  assert.strictEqual(both.side, 'both')
  assert.strictEqual(both.sourceBucketSize, 3, 'a 在该类型下共有 3 条有效出边')
  assert.strictEqual(both.targetBucketSize, 3, 'b 在该类型下共有 3 条有效入边')
  const outOnly = audit.violations.find((v) => v.view.relation.id === 'out1')!
  assert.strictEqual(outOnly.side, 'source')
  const inOnly = audit.violations.find((v) => v.view.relation.id === 'in1')!
  assert.strictEqual(inOnly.side, 'target')
})

check('审计：创建时间相同时按关系 ID 稳定决胜', () => {
  const views = capViews([
    rel('a', 'b', '支撑', 10, 'zzz'),
    rel('a', 'c', '支撑', 10, 'aaa'),
  ])
  const audit = auditRelationCardinality(views, [capRule('支撑', 1, null)])
  assert.deepStrictEqual(audit.violations.map((v) => v.view.relation.id), ['zzz'])
})

check('审计：只统计有效关系——失效关系不占名额；恢复后重新计入', () => {
  const ans = [ann('a'), ann('b'), ann('c', 'pending')]
  const rels = [rel('a', 'b', '支撑', 1, 'ok'), rel('a', 'c', '支撑', 2, 'dead')]
  const pendingViews = buildRelationViews(rels, ans)
  assert.strictEqual(auditRelationCardinality(pendingViews, [capRule('支撑', 1, null)]).count, 0)
  // c 重新绑定 → dead 恢复为有效，成为第 2 条出边 → 违规
  const reboundViews = buildRelationViews(rels, [ann('a'), ann('b'), ann('c')])
  const audit = auditRelationCardinality(reboundViews, [capRule('支撑', 1, null)])
  assert.deepStrictEqual(audit.violations.map((v) => v.view.relation.id), ['dead'])
})

check('审计：不修改输入视图与规则', () => {
  const views = capViews([rel('a', 'b', '支撑', 2, 'r2'), rel('a', 'c', '支撑', 1, 'r1')])
  const rules = [capRule('支撑', 1, null)]
  const snapshot = JSON.stringify(views)
  const ruleSnapshot = JSON.stringify(rules)
  auditRelationCardinality(views, rules)
  assert.strictEqual(JSON.stringify(views), snapshot)
  assert.strictEqual(JSON.stringify(rules), ruleSnapshot)
})

check('审计：违规端中文标签与名额文案', () => {
  const views = capViews([
    rel('a', 'x', '支撑', 1, 'earlyOut'),
    rel('y', 'b', '支撑', 2, 'earlyIn'),
    rel('a', 'b', '支撑', 3, 'both1'),
    rel('a', 'c', '支撑', 4, 'out1'),
    rel('d', 'b', '支撑', 5, 'in1'),
  ])
  const audit = auditRelationCardinality(views, [capRule('支撑', 1, 1)])
  for (const side of ['source', 'target', 'both'] as const) {
    assert.ok(CARDINALITY_SIDE_LABEL[side].includes('超限'))
  }
  const both = audit.violations.find((v) => v.view.relation.id === 'both1')!
  assert.ok(cardinalityLimitText(both).includes('最多 1 条出边（实际 3 条）'))
  assert.ok(cardinalityLimitText(both).includes('最多 1 条入边（实际 3 条）'))
})

console.log(`\n标注关系逻辑测试全部通过（${passed} 项）`)
