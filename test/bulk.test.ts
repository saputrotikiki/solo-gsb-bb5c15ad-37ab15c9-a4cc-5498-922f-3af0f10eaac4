import assert from 'node:assert'
import {
  filterAnnotations,
  normalizeBulkTags,
  planBulkTags,
  type BulkFilter,
} from '../src/lib/bulk'
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
  updatedAt = 0,
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
    updatedAt,
    contextBefore: '',
    contextAfter: '',
  }
}

const baseFilter: BulkFilter = {
  status: 'all',
  tags: [],
  tagMatch: 'all',
  keyword: '',
}

// 1. 状态筛选
check('状态筛选：全部 / 已绑定 / 待处理', () => {
  const anns = [
    ann(0, 10, ['X'], 'b1', 'bound'),
    ann(0, 0, ['Y'], 'p1', 'pending'),
    ann(5, 15, ['X'], 'b2', 'bound'),
  ]
  assert.deepStrictEqual(
    filterAnnotations(anns, baseFilter).map((a) => a.id),
    ['b1', 'b2', 'p1'],
  )
  assert.deepStrictEqual(
    filterAnnotations(anns, { ...baseFilter, status: 'bound' }).map((a) => a.id),
    ['b1', 'b2'],
  )
  assert.deepStrictEqual(
    filterAnnotations(anns, { ...baseFilter, status: 'pending' }).map((a) => a.id),
    ['p1'],
  )
})

// 2. 标签筛选：全部命中 / 任一命中
check('标签筛选：全部命中要求同时包含', () => {
  const anns = [
    ann(0, 10, ['X'], 'a'),
    ann(1, 11, ['X', 'Y'], 'b'),
    ann(2, 12, ['Y'], 'c'),
  ]
  const f: BulkFilter = { ...baseFilter, tags: ['X', 'Y'], tagMatch: 'all' }
  assert.deepStrictEqual(filterAnnotations(anns, f).map((x) => x.id), ['b'])
})

check('标签筛选：任一命中包含即可', () => {
  const anns = [
    ann(0, 10, ['X'], 'a'),
    ann(1, 11, ['X', 'Y'], 'b'),
    ann(2, 12, ['Y'], 'c'),
    ann(3, 13, ['Z'], 'd'),
  ]
  const f: BulkFilter = { ...baseFilter, tags: ['X', 'Y'], tagMatch: 'any' }
  assert.deepStrictEqual(filterAnnotations(anns, f).map((x) => x.id), ['a', 'b', 'c'])
})

// 3. 引文关键词：子串、大小写不敏感、空白裁剪
check('引文关键词：大小写不敏感子串匹配', () => {
  const anns = [
    ann(0, 10, [], 'a', 'bound', 'Hello World'),
    ann(1, 11, [], 'b', 'bound', '再见世界'),
    ann(2, 12, [], 'c', 'bound', 'worldwide'),
  ]
  const f: BulkFilter = { ...baseFilter, keyword: '  WORLD ' }
  assert.deepStrictEqual(filterAnnotations(anns, f).map((x) => x.id), ['a', 'c'])
})

// 4. 组合筛选
check('状态 + 标签 + 关键词组合筛选', () => {
  const anns = [
    ann(0, 10, ['正面'], 'a', 'bound', '很好'),
    ann(1, 11, ['正面'], 'b', 'pending', '很好'),
    ann(2, 12, ['正面', '重点'], 'c', 'bound', '普通'),
  ]
  const f: BulkFilter = {
    status: 'bound',
    tags: ['正面'],
    tagMatch: 'all',
    keyword: '很',
  }
  assert.deepStrictEqual(filterAnnotations(anns, f).map((x) => x.id), ['a'])
})

// 5. 排序：bound 按起点，pending 按更新时间降序，bound 在前
check('筛选结果按侧栏顺序排列：bound 起点升序、pending 更新时间降序', () => {
  const anns = [
    ann(30, 40, [], 'p2', 'pending', '', 10),
    ann(20, 30, [], 'b2', 'bound'),
    ann(0, 10, [], 'b1', 'bound'),
    ann(40, 50, [], 'p1', 'pending', '', 200),
  ]
  assert.deepStrictEqual(filterAnnotations(anns, baseFilter).map((a) => a.id), [
    'b1',
    'b2',
    'p1',
    'p2',
  ])
})

// 6. 批量添加：追加到末尾、已存在跳过（去重保序）
check('批量添加标签：追加末尾、已存在跳过、原顺序不变', () => {
  const anns = [
    ann(0, 10, ['甲', '乙'], 'a'),
    ann(1, 11, ['乙'], 'b'),
    ann(2, 12, ['丙', '甲', '丁'], 'c'),
  ]
  const plan = planBulkTags(anns, ['a', 'b', 'c'], 'add', ['甲', '戊'], 1000)!
  assert.ok(plan)
  assert.deepStrictEqual(plan.annotations[0].tags, ['甲', '乙', '戊'])
  assert.deepStrictEqual(plan.annotations[1].tags, ['乙', '甲', '戊'])
  // 「甲」已存在跳过；「戊」追加
  assert.deepStrictEqual(plan.annotations[2].tags, ['丙', '甲', '丁', '戊'])
  assert.strictEqual(plan.affectedCount, 3)
  // 变化明细
  const changeA = plan.changes.find((c) => c.annotationId === 'a')!
  assert.deepStrictEqual(changeA.added, ['戊'])
  assert.deepStrictEqual(changeA.removed, [])
  // 输入不被修改
  assert.deepStrictEqual(anns[0].tags, ['甲', '乙'])
  // updatedAt 更新
  assert.strictEqual(plan.annotations[0].updatedAt, 1000)
})

// 7. 全部已持有 → affectedCount 为 0，数据不变
check('添加已全部存在的标签：无变化、updatedAt 不变', () => {
  const anns = [ann(0, 10, ['甲', '乙'], 'a', 'bound', '', 500)]
  const plan = planBulkTags(anns, ['a'], 'add', ['乙', '甲'], 1000)!
  assert.strictEqual(plan.affectedCount, 0)
  assert.strictEqual(plan.changes.length, 0)
  assert.strictEqual(plan.annotations[0].updatedAt, 500)
  assert.strictEqual(plan.annotations[0], anns[0])
})

// 8. 批量移除：保序、只动实际持有标签的标注
check('批量移除标签：其余标签保持原顺序', () => {
  const anns = [
    ann(0, 10, ['甲', '乙', '丙', '乙'], 'a'),
    ann(1, 11, ['丙'], 'b'),
    ann(2, 12, ['丁'], 'c'),
  ]
  const plan = planBulkTags(anns, ['a', 'b', 'c'], 'remove', ['乙'], 1000)!
  assert.deepStrictEqual(plan.annotations[0].tags, ['甲', '丙'])
  assert.deepStrictEqual(plan.annotations[1].tags, ['丙'])
  assert.deepStrictEqual(plan.annotations[2].tags, ['丁'])
  assert.strictEqual(plan.affectedCount, 1)
  const changeA = plan.changes.find((c) => c.annotationId === 'a')!
  assert.deepStrictEqual(changeA.removed, ['乙', '乙'])
  assert.deepStrictEqual(changeA.added, [])
  // 未变化标注保持同一引用
  assert.strictEqual(plan.annotations[2], anns[2])
})

// 9. 移除全部不持有的标签 → 无变化
check('移除均不持有的标签：affectedCount 为 0', () => {
  const anns = [ann(0, 10, ['甲'], 'a')]
  const plan = planBulkTags(anns, ['a'], 'remove', ['X', 'Y'], 1000)!
  assert.strictEqual(plan.affectedCount, 0)
  assert.strictEqual(plan.annotations[0], anns[0])
})

// 10. 只作用于选中的标注；不存在的 ID 忽略
check('操作范围仅限选中 ID，未知 ID 忽略；输出顺序与输入一致', () => {
  const anns = [
    ann(0, 10, ['甲'], 'a'),
    ann(1, 11, ['甲'], 'b'),
    ann(2, 12, ['甲'], 'c'),
  ]
  const plan = planBulkTags(anns, ['b', 'ghost'], 'add', ['乙'], 1000)!
  assert.deepStrictEqual(plan.annotations.map((a) => a.id), ['a', 'b', 'c'])
  assert.deepStrictEqual(plan.annotations[0].tags, ['甲'])
  assert.deepStrictEqual(plan.annotations[1].tags, ['甲', '乙'])
  assert.deepStrictEqual(plan.annotations[2].tags, ['甲'])
  assert.deepStrictEqual(plan.targetIds, ['b'])
  assert.strictEqual(plan.affectedCount, 1)
})

// 11. 空选中集
check('空选中集：无变化', () => {
  const anns = [ann(0, 10, [], 'a')]
  const plan = planBulkTags(anns, [], 'add', ['X'], 1000)!
  assert.strictEqual(plan.affectedCount, 0)
  assert.strictEqual(plan.annotations[0], anns[0])
})

// 12. 标签归一：去空白 / 前导 #、保序去重
check('操作标签归一：去 # 与空白、保序去重', () => {
  assert.deepStrictEqual(normalizeBulkTags([' #甲 ', '甲', '  ', '乙', '乙']), [
    '甲',
    '乙',
  ])
  const anns = [ann(0, 10, [], 'a')]
  const plan = planBulkTags(anns, ['a'], 'add', [' 甲 ', '#甲', '乙'], 1)!
  assert.deepStrictEqual(plan!.tags, ['甲', '乙'])
  assert.deepStrictEqual(plan!.annotations[0].tags, ['甲', '乙'])
})

// 13. 空标签输入返回 null
check('操作标签为空（或全空白）时返回 null', () => {
  const anns = [ann(0, 10, ['甲'], 'a')]
  assert.strictEqual(planBulkTags(anns, ['a'], 'add', []), null)
  assert.strictEqual(planBulkTags(anns, ['a'], 'remove', ['  ', '#']), null)
})

// 14. pending 标注同样参与
check('pending 标注同样参与批量操作', () => {
  const anns = [ann(0, 0, ['甲'], 'p', 'pending')]
  const plan = planBulkTags(anns, ['p'], 'add', ['乙'], 1000)!
  assert.strictEqual(plan.annotations[0].status, 'pending')
  assert.deepStrictEqual(plan.annotations[0].tags, ['甲', '乙'])
})

// 15. 端到端：筛选 → 选中筛选结果 → 添加落地
check('端到端：筛选结果全选后批量添加，落地标签自洽', () => {
  const anns = [
    ann(0, 10, ['正面'], 'a', 'bound', '好评'),
    ann(20, 30, ['反面'], 'b', 'bound', '差评'),
    ann(40, 50, ['正面'], 'p', 'pending', '好评旧'),
  ]
  const matched = filterAnnotations(anns, {
    status: 'bound',
    tags: ['正面'],
    tagMatch: 'all',
    keyword: '',
  })
  const plan = planBulkTags(
    anns,
    matched.map((a) => a.id),
    'add',
    ['复核'],
    1000,
  )!
  assert.deepStrictEqual(plan.annotations.map((a) => a.tags), [
    ['正面', '复核'],
    ['反面'],
    ['正面'],
  ])
  assert.strictEqual(plan.affectedCount, 1)
})

console.log(`\nbulk：${passed} 项断言全部通过`)
