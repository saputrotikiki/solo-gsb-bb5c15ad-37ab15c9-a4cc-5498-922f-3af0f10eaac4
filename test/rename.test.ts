import assert from 'node:assert'
import { planTagRename } from '../src/lib/rename'
import { detectConflicts } from '../src/lib/conflicts'
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
    updatedAt:0,
    contextBefore: '',
    contextAfter: '',
  }
}

function rule(id: string, tagA: string, tagB: string, createdAt = 1): ConflictRule {
  return { id, tagA, tagB, createdAt }
}

function ignored(a: string, b: string, ruleIds: string[], createdAt = 1): IgnoredConflict {
  return { annotationIds: [a, b], ruleIds, createdAt }
}

// 1. 基本：标注标签精确替换，未引用源标签的不动
check('基本重命名：标注标签精确替换', () => {
  const doc = {
    annotations: [
      ann(0, 10, ['正面', '重点'], 'x'),
      ann(5, 15, ['反面'], 'y'),
    ],
    conflictRules: [],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '正面', '褒奖')!
  assert.ok(plan)
  assert.strictEqual(plan.annotationChanges.length, 1)
  assert.deepStrictEqual(plan.annotations[0].tags, ['褒奖', '重点'])
  assert.deepStrictEqual(plan.annotations[1].tags, ['反面'])
  // 输入不被修改
  assert.deepStrictEqual(doc.annotations[0].tags, ['正面', '重点'])
  assert.strictEqual(plan.annotationChanges[0].removedDuplicates, 0)
})

// 2. 同条标注已含目标标签：去重且保留原顺序（靠前者留位）
check('同条标注内含目标标签：去重并保留原顺序', () => {
  const doc = {
    annotations: [
      ann(0, 10, ['中性', '正面', '补充', '正面', '正面'], 'x'),
      ann(0, 10, ['正面', '中性'], 'y'),
      ann(0, 10, ['中性', '正面'], 'z'),
    ],
    conflictRules: [],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '正面', '中性')!
  // 源在第 2 位，目标在第 1 位 → 第 2/4/5 位的源全部并入第 1 位
  assert.deepStrictEqual(plan.annotations[0].tags, ['中性', '补充'])
  assert.strictEqual(plan.annotationChanges[0].removedDuplicates, 3)
  // 源在第 1 位、目标在第 2 位 → 源位置保留，后面的目标并入
  assert.deepStrictEqual(plan.annotations[1].tags, ['中性'])
  assert.deepStrictEqual(plan.annotations[2].tags, ['中性'])
})

// 3. 规则两端同步替换，方向无关
check('互斥规则两端同步替换', () => {
  const doc = {
    annotations: [ann(0, 10, ['正面'], 'x')],
    conflictRules: [
      rule('r1', '正面', '反面', 10),
      rule('r2', '褒义', '正面', 20),
      rule('r3', '褒义', '贬义', 30),
    ],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '正面', '正面2')!
  assert.strictEqual(plan.affectedRuleCount, 2)
  const byId = new Map(plan.rules.map((r) => [r.id, r]))
  assert.deepStrictEqual([byId.get('r1')!.tagA, byId.get('r1')!.tagB], ['正面2', '反面'])
  assert.deepStrictEqual([byId.get('r2')!.tagA, byId.get('r2')!.tagB], ['褒义', '正面2'])
  // 未触及规则保持不变，且 ID/createdAt 不变
  assert.deepStrictEqual(byId.get('r3'), rule('r3', '褒义', '贬义', 30))
})

// 4. 自互斥规则（替换后两端相同）删除
check('替换后自互斥的规则删除', () => {
  const doc = {
    annotations: [ann(0, 10, ['正面'], 'x')],
    conflictRules: [rule('r1', '正面', '正面2', 10)],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '正面', '正面2')!
  assert.strictEqual(plan.rules.length, 0)
  assert.strictEqual(plan.deletedRuleCount, 1)
  assert.strictEqual(plan.ruleChanges[0].kind, 'deleted')
  // 自互斥删除不产生 ID 映射
  assert.deepStrictEqual(plan.ruleIdMap, {})
})

// 5. 无序重复规则按 createdAt 保留最早一条，createdAt 相同按 id
check('重复规则合并：按 createdAt、id 保留最早一条', () => {
  const doc = {
    annotations: [
      ann(0, 10, ['新名', 'B'], 'x'),
      ann(5, 15, ['A'], 'y'),
    ],
    conflictRules: [
      rule('r_later', '旧名', 'A', 20),
      rule('r_existing', 'A', '新名', 10),
      rule('r_mid', '旧名', 'A', 15),
    ],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '旧名', '新名')!
  assert.strictEqual(plan.rules.length, 1)
  assert.strictEqual(plan.rules[0].id, 'r_existing')
  assert.strictEqual(plan.mergedRuleCount, 2)
  assert.deepStrictEqual(plan.ruleIdMap, {
    r_later: 'r_existing',
    r_mid: 'r_existing',
  })
  // 保留方是未触及源标签的既有规则：无 changed 明细；两条被合并方各一条 merged
  assert.strictEqual(plan.ruleChanges.filter((c) => c.kind === 'changed').length, 0)
  const merged = plan.ruleChanges.filter((c) => c.kind === 'merged')
  assert.strictEqual(merged.length, 2)
  assert.ok(merged.every((c) => c.survivor!.id === 'r_existing'))
  const mergedIds = merged.map((c) => c.rule.id).sort()
  assert.deepStrictEqual(mergedIds, ['r_later', 'r_mid'])
})

check('重复规则合并时保留方自身也改名：保留最早一条并记 changed', () => {
  const doc = {
    annotations: [
      ann(0, 10, ['新名'], 'x'),
      ann(5, 15, ['A'], 'y'),
    ],
    conflictRules: [
      rule('r_old_late', '旧名', 'A', 20),
      rule('r_old_early', 'A', '旧名', 10),
      rule('r_existing', '新名', 'A', 30),
    ],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '旧名', '新名')!
  assert.strictEqual(plan.rules.length, 1)
  // 最早一条是替换后的 r_old_early（createdAt 10），它自身标签被替换 → changed
  assert.strictEqual(plan.rules[0].id, 'r_old_early')
  const changed = plan.ruleChanges.find((c) => c.kind === 'changed')!
  assert.strictEqual(changed.rule.id, 'r_old_early')
  assert.strictEqual(changed.absorbedCount, 2)
  assert.strictEqual(plan.mergedRuleCount, 2)
  assert.deepStrictEqual(plan.ruleIdMap, {
    r_old_late: 'r_old_early',
    r_existing: 'r_old_early',
  })
})

check('重复规则 created 时间相同时按 id 字典序保留', () => {
  const doc = {
    annotations: [ann(0, 10, ['新名'], 'x')],
    conflictRules: [
      rule('rb', '旧名', 'A', 10),
      rule('ra', '旧名', 'A', 10),
    ],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '旧名', '新名')!
  assert.strictEqual(plan.rules[0].id, 'ra')
  assert.strictEqual(plan.ruleIdMap.rb, 'ra')
})

// 6. 忽略记录：被合并规则的 ID 映射到保留规则，签名仍命中则保留（忽略延续）
check('忽略记录随规则合并改写并继续生效', () => {
  const doc = {
    annotations: [
      ann(0, 10, ['旧名'], 'x'),
      ann(5, 15, ['A'], 'y'),
    ],
    conflictRules: [
      rule('r_old', '旧名', 'A', 20),
      rule('r_keep', '新名', 'A', 10),
    ],
    // 用户此前按 r_old 忽略了 x/y 冲突
    ignoredConflicts: [ignored('x', 'y', ['r_old'], 5)],
  }
  const plan = planTagRename(doc, '旧名', '新名')!
  assert.strictEqual(plan.keptIgnoredCount, 1)
  assert.deepStrictEqual(plan.ignoredConflicts[0].ruleIds, ['r_keep'])
  assert.strictEqual(plan.rewrittenIgnoredCount, 1)
  assert.strictEqual(plan.removedIgnoredCount, 0)
  // 落地后重新检测，该冲突仍处于忽略状态
  const cs = detectConflicts(
    plan.annotations,
    plan.rules,
    plan.ignoredConflicts,
  )
  assert.strictEqual(cs.length, 1)
  assert.strictEqual(cs[0].ignored, true)
})

// 7. 忽略记录：替换后标签不再命中规则（冲突消失）→ 清理
check('冲突签名不再产生的忽略记录被清理', () => {
  const doc = {
    annotations: [
      ann(0, 10, ['正面', 'B'], 'x'),
      ann(5, 15, ['B'], 'y'),
    ],
    // 忽略记录引用了已不存在的标注 z：属于旧悬空签名，应清理
    conflictRules: [rule('r1', '正面', 'C', 1)],
    ignoredConflicts: [ignored('x', 'z', ['r1'], 1)],
  }
  const plan = planTagRename(doc, '正面', '中性')!
  assert.strictEqual(plan.removedIgnoredCount, 1)
  assert.strictEqual(plan.ignoredConflicts.length, 0)
})

check('一方为 pending 标注时忽略签名无法对应 → 清理', () => {
  // 重命名前 x 已处于 pending（不参与冲突检测），(x,y) 的旧忽略记录不可能再命中
  const doc = {
    annotations: [
      ann(0, 10, ['正面'], 'x', 'pending'),
      ann(5, 15, ['反面'], 'y'),
    ],
    conflictRules: [rule('r1', '正面', '反面', 1)],
    ignoredConflicts: [ignored('x', 'y', ['r1'], 1)],
  }
  const plan = planTagRename(doc, '正面', '中性')!
  assert.strictEqual(plan.removedIgnoredCount, 1)
  assert.strictEqual(plan.ignoredConflicts.length, 0)
})

check('锁步重命名保留互斥关系：规则随标签同步改名，忽略延续', () => {
  // 标签与规则两端一起改名 → 冲突依然存在，忽略记录继续生效（不被误清）
  const doc = {
    annotations: [
      ann(0, 10, ['正面'], 'x'),
      ann(5, 15, ['反面'], 'y'),
    ],
    conflictRules: [rule('r1', '正面', '反面', 1)],
    ignoredConflicts: [ignored('x', 'y', ['r1'], 1)],
  }
  const plan = planTagRename(doc, '正面', '中性')!
  assert.strictEqual(plan.rules[0].tagA, '中性')
  assert.strictEqual(plan.keptIgnoredCount, 1)
  assert.strictEqual(plan.removedIgnoredCount, 0)
  const cs = detectConflicts(plan.annotations, plan.rules, plan.ignoredConflicts)
  assert.strictEqual(cs.length, 1)
  assert.strictEqual(cs[0].ignored, true)
})

// 8. 自互斥规则删除导致引用它的忽略记录无规则可用 → 清理
check('自互斥规则删除后引用它的忽略记录清理', () => {
  const doc = {
    annotations: [
      ann(0, 10, ['正面'], 'x'),
      ann(5, 15, ['正面'], 'y'),
    ],
    conflictRules: [rule('r1', '正面', '反面', 1)],
    ignoredConflicts: [ignored('x', 'y', ['r1'], 1)],
  }
  // 正面→反面：规则 r1 变 反面⇄反面 被删；x/y 都含反面，无现存规则
  const plan = planTagRename(doc, '正面', '反面')!
  assert.strictEqual(plan.deletedRuleCount, 1)
  assert.strictEqual(plan.removedIgnoredCount, 1)
  assert.strictEqual(plan.ignoredConflicts.length, 0)
})

// 9. 多条忽略记录映射到同一签名：保留最早一条
check('合并后重复的忽略签名保留最早一条', () => {
  const doc = {
    annotations: [
      ann(0, 10, ['旧名'], 'x'),
      ann(5, 15, ['A'], 'y'),
    ],
    conflictRules: [
      rule('r1', '旧名', 'A', 1),
      rule('r2', '旧名', 'A', 2),
      rule('r3', '新名', 'A', 3),
    ],
    ignoredConflicts: [
      ignored('x', 'y', ['r1'], 100),
      ignored('x', 'y', ['r2'], 50),
    ],
  }
  const plan = planTagRename(doc, '旧名', '新名')!
  // r1/r2/r3 替换后同对，取 createdAt 最早的 r1 保留
  assert.strictEqual(plan.rules.length, 1)
  assert.strictEqual(plan.rules[0].id, 'r1')
  assert.strictEqual(plan.ignoredConflicts.length, 1)
  assert.strictEqual(plan.ignoredConflicts[0].createdAt, 50)
  assert.deepStrictEqual(plan.ignoredConflicts[0].ruleIds, ['r1'])
  assert.strictEqual(plan.removedIgnoredCount, 1)
})

// 10. 无效输入：目标为空 / 与源相同 / 源不存在 / 去 # 与空白归一
check('无效输入返回 null', () => {
  const doc = {
    annotations: [ann(0, 10, ['正面'], 'x')],
    conflictRules: [],
    ignoredConflicts: [],
  }
  assert.strictEqual(planTagRename(doc, '正面', ''), null)
  assert.strictEqual(planTagRename(doc, '正面', '   '), null)
  assert.strictEqual(planTagRename(doc, '正面', '#正面'), null)
  assert.strictEqual(planTagRename(doc, '不存在', 'X'), null)
  assert.strictEqual(planTagRename(doc, '', 'X'), null)
})

check('源/目标标签自动去 # 与空白', () => {
  const doc = {
    annotations: [ann(0, 10, ['正面'], 'x')],
    conflictRules: [],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, ' #正面 ', '  褒奖 ')!
  assert.strictEqual(plan.source, '正面')
  assert.strictEqual(plan.target, '褒奖')
  assert.deepStrictEqual(plan.annotations[0].tags, ['褒奖'])
})

// 11. 源标签只被规则引用（无标注使用）也可重命名
check('仅规则引用的标签也可作为源标签', () => {
  const doc = {
    annotations: [ann(0, 10, ['A'], 'x')],
    conflictRules: [rule('r1', '孤儿标签', 'A', 1)],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '孤儿标签', '新标签')!
  assert.strictEqual(plan.annotationChanges.length, 0)
  assert.strictEqual(plan.rules[0].tagA, '新标签')
})

// 12. pending 标注同样替换标签，顺序保持
check('pending 标注标签同样替换', () => {
  const doc = {
    annotations: [ann(0, 0, ['正面', '备注'], 'x', 'pending')],
    conflictRules: [],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '正面', '新')!
  assert.deepStrictEqual(plan.annotations[0].tags, ['新', '备注'])
  assert.strictEqual(plan.annotations[0].status, 'pending')
})

// 13. 端到端：落地数据自洽——pruneIgnored 不会额外删记录，检测结果稳定
check('落地结果自洽：忽略集合与重检测一致', () => {
  const doc = {
    annotations: [
      ann(0, 20, ['旧名', 'B'], 'x'),
      ann(10, 30, ['A', '旧名'], 'y'),
      ann(40, 50, ['旧名'], 'z'),
      ann(42, 48, ['A'], 'w'),
    ],
    conflictRules: [
      rule('r1', '旧名', 'A', 1),
      rule('r2', '新名', 'A', 2), // 将与 r1 替换后重复
      rule('r3', 'B', 'C', 3), // 不触及
    ],
    ignoredConflicts: [
      ignored('z', 'w', ['r1'], 9), // 替换后映射到 r2，仍命中 → 保留
      ignored('x', 'y', ['r3'], 8), // x/y 实际不命中 r3（旧悬空签名）→ 清理
    ],
  }
  const plan = planTagRename(doc, '旧名', '新名')!
  assert.strictEqual(plan.rules.length, 2)
  assert.deepStrictEqual(plan.rules.map((r) => r.id).sort(), ['r1', 'r3'])
  assert.strictEqual(plan.ruleIdMap.r2, 'r1')
  assert.strictEqual(plan.ignoredConflicts.length, 1)
  assert.deepStrictEqual(plan.ignoredConflicts[0].annotationIds, ['w', 'z'])
  assert.deepStrictEqual(plan.ignoredConflicts[0].ruleIds, ['r1'])
  const cs = detectConflicts(
    plan.annotations,
    plan.rules,
    plan.ignoredConflicts,
  )
  const pairs = cs.map((c) => `${c.annotationIds[0]}/${c.annotationIds[1]}:${c.ignored}`)
  assert.deepStrictEqual(pairs.sort(), ['w/z:true', 'x/y:false'])
})

// 14. 预览明细数量与计数一致
check('预览计数与明细一致', () => {
  const doc = {
    annotations: [
      ann(0, 10, ['旧名'], 'x'),
      ann(0, 10, ['无关注'], 'y'),
    ],
    conflictRules: [
      rule('r1', '旧名', 'A', 1),
      rule('r2', '旧名', 'A', 2),
      rule('r3', '旧名', '旧名2', 3),
      rule('r4', 'K', 'L', 4),
    ],
    ignoredConflicts: [],
  }
  const plan = planTagRename(doc, '旧名', '旧名2')!
  // r1/r2 合并（1 changed + 1 merged），r3 自互斥删除，r4 不触及
  assert.strictEqual(plan.affectedRuleCount, 3)
  assert.strictEqual(plan.mergedRuleCount, 1)
  assert.strictEqual(plan.deletedRuleCount, 1)
  assert.strictEqual(plan.rules.length, 2) // 合并后 1 条 + r4
})

console.log(`\n全部 ${passed} 项通过`)
