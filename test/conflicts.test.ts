import assert from 'node:assert'
import {
  activeConflictRanges,
  conflictIgnoredKey,
  detectConflicts,
  ignoredKey,
  isConflictSegment,
  normalizeIgnored,
  normalizeRules,
  pruneIgnored,
} from '../src/lib/conflicts'
import type { Annotation, ConflictRule, IgnoredConflict } from '../src/types'

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
): Annotation {
  seq += 1
  return {
    id: id ?? `a${seq}`,
    quote: '',
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

function rule(id: string, tagA: string, tagB: string, createdAt = 1): ConflictRule {
  return { id, tagA, tagB, createdAt }
}

// 1. 基本命中：区间相交且标签分别命中互斥对两侧
check('基本冲突：交叠 + 标签命中同一互斥对', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [ann(0, 10, ['正面'], 'x'), ann(5, 15, ['反面'], 'y')]
  const cs = detectConflicts(ans, rules, [])
  assert.strictEqual(cs.length, 1)
  assert.deepStrictEqual(cs[0].annotationIds, ['x', 'y'])
  assert.strictEqual(cs[0].overlapStart, 5)
  assert.strictEqual(cs[0].overlapEnd, 10)
  assert.deepStrictEqual(cs[0].rules.map((r) => r.id), ['r1'])
  assert.strictEqual(cs[0].ignored, false)
})

// 2. 标签方向相反也算命中
check('标签方向相反（反面在前）同样命中', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [ann(0, 10, ['反面']), ann(5, 15, ['正面'])]
  assert.strictEqual(detectConflicts(ans, rules, []).length, 1)
})

// 3. 至少 1 个字符交集：端点相接（半开区间）不算
check('端点相接不算冲突（必须有字符交集）', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [ann(0, 10, ['正面']), ann(10, 20, ['反面'])]
  assert.strictEqual(detectConflicts(ans, rules, []).length, 0)
})

// 4. 区间不相交不冲突
check('区间分离不冲突', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [ann(0, 5, ['正面']), ann(6, 10, ['反面'])]
  assert.strictEqual(detectConflicts(ans, rules, []).length, 0)
})

// 5. 标签不命中规则不冲突
check('标签未命中互斥对不冲突', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [ann(0, 10, ['正面']), ann(5, 15, ['中立'])]
  assert.strictEqual(detectConflicts(ans, rules, []).length, 0)
  // 同一条规则同侧也不算
  const ans2 = [ann(0, 10, ['正面']), ann(5, 15, ['正面'])]
  assert.strictEqual(detectConflicts(ans2, rules, []).length, 0)
})

// 6. pending 标注不参与检测
check('pending 标注不参与冲突检测', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [
    ann(0, 10, ['正面'], 'x'),
    ann(5, 15, ['反面'], 'y', 'pending'),
  ]
  assert.strictEqual(detectConflicts(ans, rules, []).length, 0)
})

// 7. 同一标注对命中多条规则只产生一个冲突项，规则全部列出
check('多规则命中合并为一条并列出全部规则', () => {
  const rules = [rule('r1', '正面', '反面'), rule('r2', '褒义', '贬义')]
  const ans = [
    ann(0, 10, ['正面', '褒义'], 'x'),
    ann(5, 15, ['反面', '贬义'], 'y'),
  ]
  const cs = detectConflicts(ans, rules, [])
  assert.strictEqual(cs.length, 1)
  assert.deepStrictEqual(cs[0].rules.map((r) => r.id), ['r1', 'r2'])
})

// 8. 标注 ID 对按字典序排列，与枚举顺序无关
check('标注 ID 对按字典序排列', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [ann(5, 15, ['反面'], 'zzz'), ann(0, 10, ['正面'], 'aaa')]
  const cs = detectConflicts(ans, rules, [])
  assert.deepStrictEqual(cs[0].annotationIds, ['aaa', 'zzz'])
})

// 9. 按交叠起点排序
check('冲突项按交叠起点升序排列', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [
    ann(0, 40, ['正面'], 'base'),
    ann(30, 40, ['反面'], 'late'), // 交叠 30
    ann(10, 20, ['反面'], 'early'), // 交叠 10
    ann(20, 30, ['反面'], 'mid'), // 交叠 20
  ]
  const cs = detectConflicts(ans, rules, [])
  assert.deepStrictEqual(cs.map((c) => c.overlapStart), [10, 20, 30])
})

// 10. 忽略签名命中后标记 ignored
check('忽略记录按「标注对+规则集合」签名生效', () => {
  const rules = [rule('r1', '正面', '反面'), rule('r2', '褒义', '贬义')]
  const ans = [
    ann(0, 10, ['正面', '褒义'], 'x'),
    ann(5, 15, ['反面', '贬义'], 'y'),
  ]
  // 只忽略 r1 命中 → 两规则都命中时集合不同，不应忽略
  const ignoreR1: IgnoredConflict[] = [
    { annotationIds: ['x', 'y'], ruleIds: ['r1'], createdAt: 1 },
  ]
  const cs1 = detectConflicts(ans, rules, ignoreR1)
  assert.strictEqual(cs1[0].ignored, false)

  // 忽略完整集合 → 生效
  const ignoreAll: IgnoredConflict[] = [
    { annotationIds: ['x', 'y'], ruleIds: ['r1', 'r2'], createdAt: 1 },
  ]
  const cs2 = detectConflicts(ans, rules, ignoreAll)
  assert.strictEqual(cs2[0].ignored, true)
})

// 11. 签名不含区间：区间重定位后忽略不失效
check('区间重定位（仅坐标变化）不导致忽略失效', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ignored: IgnoredConflict[] = [
    { annotationIds: ['x', 'y'], ruleIds: ['r1'], createdAt: 1 },
  ]
  const before = detectConflicts(
    [ann(0, 10, ['正面'], 'x'), ann(5, 15, ['反面'], 'y')],
    rules,
    ignored,
  )
  assert.strictEqual(before[0].ignored, true)
  // 编辑原文后整体后移 100，签名依旧命中
  const after = detectConflicts(
    [ann(100, 110, ['正面'], 'x'), ann(105, 115, ['反面'], 'y')],
    rules,
    ignored,
  )
  assert.strictEqual(after.length, 1)
  assert.strictEqual(after[0].ignored, true)
})

// 12. 标签变化导致规则集合改变时自动重新出现
check('标签变化使命中规则集合改变 → 冲突重新出现', () => {
  const rules = [
    rule('r1', '正面', '反面'),
    rule('r2', '褒义', '贬义'),
  ]
  // 之前只命中 r1 并已忽略
  const ignored: IgnoredConflict[] = [
    { annotationIds: ['x', 'y'], ruleIds: ['r1'], createdAt: 1 },
  ]
  const ans = [
    ann(0, 10, ['正面', '褒义'], 'x'),
    ann(5, 15, ['反面', '贬义'], 'y'),
  ]
  // 现在两条规则都命中 → 签名变成 {r1,r2}，旧忽略不再匹配
  const cs = detectConflicts(ans, rules, ignored)
  assert.strictEqual(cs[0].ignored, false)
  assert.deepStrictEqual(cs[0].rules.map((r) => r.id), ['r1', 'r2'])
})

// 13. 一条标注同时含互斥对两侧标签：与另一条只命中单侧的标注冲突
check('单条同时含两侧标签时与单侧标注仍命中', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [ann(0, 10, ['正面', '反面'], 'x'), ann(5, 15, ['反面'], 'y')]
  assert.strictEqual(detectConflicts(ans, rules, []).length, 1)
})

// 14. 规则归一化：去 #、去空白、丢弃非法与重复
check('normalizeRules：清洗、丢弃非法/重复', () => {
  const rs = normalizeRules([
    { id: 'g1', tagA: '#正面', tagB: ' 反面 ', createdAt: 1 },
    { id: 'g2', tagA: '正面', tagB: '反面', createdAt: 2 }, // 与上行重复
    { id: 'g3', tagA: '同', tagB: '同', createdAt: 3 }, // 两侧相同
    { id: 'g4', tagA: '', tagB: '反面', createdAt: 4 }, // 空
    null,
    { tagA: '褒义', tagB: '贬义' }, // 无 id 自动补
  ])
  assert.strictEqual(rs.length, 2)
  assert.strictEqual(rs[0].tagA, '正面')
  assert.strictEqual(rs[0].tagB, '反面')
  assert.strictEqual(rs[0].id, 'g1')
  assert.ok(rs[1].id)
  assert.strictEqual(rs[1].tagA, '褒义')
})

// 15. 忽略记录归一化与排序
check('normalizeIgnored：ID 对与规则集合排序、非法丢弃', () => {
  const out = normalizeIgnored([
    { annotationIds: ['y', 'x'], ruleIds: ['b', 'a', 'a'], createdAt: 5 },
    { annotationIds: ['only'], ruleIds: ['r1'] },
    { annotationIds: ['a', 'a'], ruleIds: ['r1'] },
    { annotationIds: ['a', 'b'], ruleIds: [] },
  ])
  assert.strictEqual(out.length, 1)
  assert.deepStrictEqual(out[0].annotationIds, ['x', 'y'])
  assert.deepStrictEqual(out[0].ruleIds, ['a', 'b'])
  assert.strictEqual(out[0].createdAt, 5)
})

// 16. pruneIgnored：删标注 / 删规则后清理
check('pruneIgnored：标注或规则删除后签名失效被清理', () => {
  const rules = [rule('r1', '正面', '反面'), rule('r2', '褒义', '贬义')]
  const ans = [ann(0, 5, ['正面'], 'x'), ann(0, 5, ['反面'], 'y')]
  const ignored: IgnoredConflict[] = [
    { annotationIds: ['x', 'y'], ruleIds: ['r1', 'r2'], createdAt: 1 }, // r2 已删但 r1 还在 → 保留
    { annotationIds: ['x', 'z'], ruleIds: ['r1'], createdAt: 2 }, // z 标注已删 → 清除
    { annotationIds: ['x', 'y'], ruleIds: ['r9'], createdAt: 3 }, // 规则全部已删 → 清除
  ]
  const out = pruneIgnored(ignored, ans, rules)
  assert.strictEqual(out.length, 1)
  assert.deepStrictEqual(out[0].annotationIds, ['x', 'y'])
  assert.deepStrictEqual(out[0].ruleIds, ['r1', 'r2'])
})

// 17. 交叠区间工具：activeConflictRanges / isConflictSegment
check('activeConflictRanges 与 isConflictSegment', () => {
  const rules = [rule('r1', '正面', '反面')]
  const ans = [
    ann(0, 20, ['正面'], 'x'),
    ann(10, 20, ['反面'], 'y'),
    ann(0, 10, ['反面'], 'z'),
  ]
  const ignored: IgnoredConflict[] = [
    { annotationIds: ['x', 'z'], ruleIds: ['r1'], createdAt: 1 }, // x/z（0,10）被忽略
  ]
  const cs = detectConflicts(ans, rules, ignored)
  const ranges = activeConflictRanges(cs)
  // 只剩 x/y 的 [10,20)
  assert.deepStrictEqual(ranges, [{ start: 10, end: 20 }])
  assert.strictEqual(isConflictSegment(ranges, 10, 15), true)
  assert.strictEqual(isConflictSegment(ranges, 0, 10), false)
})

// 18. 签名键稳定（与数组顺序无关）
check('ignoredKey：标注对与规则顺序不影响键', () => {
  const k1 = ignoredKey(['a', 'b'], ['r1', 'r2'])
  const k2 = ignoredKey(['b', 'a'], ['r2', 'r1'])
  assert.strictEqual(k1, k2)
  const k3 = ignoredKey(['a', 'c'], ['r1', 'r2'])
  assert.notStrictEqual(k1, k3)
})

// 19. conflictIgnoredKey 与 ignoreConflict 写入的签名一致（回归保护）
check('conflictIgnoredKey 与忽略记录键一致', () => {
  const rules = [rule('r1', '正面', '反面')]
  const cs = detectConflicts(
    [ann(0, 10, ['正面'], 'x'), ann(5, 15, ['反面'], 'y')],
    rules,
    [],
  )
  const key = conflictIgnoredKey(cs[0])
  const stored = ignoredKey(['x', 'y'], ['r1'])
  assert.strictEqual(key, stored)
})

console.log(`\n全部 ${passed} 项通过`)
