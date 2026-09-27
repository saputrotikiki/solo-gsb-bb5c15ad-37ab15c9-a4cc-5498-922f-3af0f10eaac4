// 标签重命名：一次性原子地完成标签替换
//
// 涉及三类数据的同步变更：
// 1. 标注 tags：精确替换源标签；同条标注内因替换产生的重名标签去重，保留首次出现的位置（即原顺序）。
// 2. 互斥规则：规则两端同步替换；替换后两侧相同的「自互斥规则」删除；
//    替换后形成的无序重复标签对按 (createdAt, id) 保留最早一条，其余被合并。
//    被删除/被合并规则的 ID 在 ruleIdMap 中映射到保留规则（自互斥规则无对应保留规则，不建立映射）。
// 3. 忽略记录：先按 ruleIdMap 改写规则引用，再仅保留仍能对应当前冲突签名的记录；
//    改写后多条记录指向同一签名时保留最早一条。

import type {
  Annotation,
  ConflictRule,
  IgnoredConflict,
  SampleTarget,
} from '../types'
import {
  conflictIgnoredKey,
  detectConflicts,
  ignoredKey,
  normalizeTag,
  rulePairKey,
} from './conflicts'

/** 一条标注的标签变更明细（用于预览） */
export interface AnnotationTagChange {
  annotationId: string
  quote: string
  before: string[]
  after: string[]
  /** 去重导致减少的标签数（源/目标原本同条共存时为 1，否则为 0） */
  removedDuplicates: number
}

/** 一条互斥规则的变更明细（用于预览） */
export interface RuleChange {
  /** changed=保留但标签被替换；merged=重复被合并；deleted=自互斥删除 */
  kind: 'changed' | 'merged' | 'deleted'
  /** 变更前规则（merged 时为被合并方的原规则） */
  rule: ConflictRule
  /** changed / merged 时最终保留的规则 */
  survivor?: ConflictRule
  /** changed 且吸收了其他规则时，被吸收的条数 */
  absorbedCount?: number
}

/** 标签重命名的完整计划：既是预览数据，也是落地依据 */
export interface TagRenamePlan {
  source: string
  target: string
  /** 落地后的完整数据 */
  annotations: Annotation[]
  rules: ConflictRule[]
  ignoredConflicts: IgnoredConflict[]
  /** 覆盖审计所选标签（同步精确替换，保序去重） */
  coverageTags: string[]
  /** 抽样复核配置中的标签配额：标签跟随重命名，同一目标的配额相加 */
  sampleTargets: SampleTarget[]
  annotationChanges: AnnotationTagChange[]
  ruleChanges: RuleChange[]
  /** 引用了源标签的规则总数（= changed + merged + deleted 明细数） */
  affectedRuleCount: number
  mergedRuleCount: number
  deletedRuleCount: number
  /** 被合并/删除规则 ID → 保留规则 ID（自互斥删除不映射） */
  ruleIdMap: Record<string, string>
  keptIgnoredCount: number
  /** 保留下来、但规则 ID 集合经映射被改写的忽略记录数 */
  rewrittenIgnoredCount: number
  /** 已无法对应当前冲突签名（或映射后重复）而被清理的忽略记录数 */
  removedIgnoredCount: number
}

interface RenamePlanInput {
  annotations: Annotation[]
  conflictRules: ConflictRule[]
  ignoredConflicts: IgnoredConflict[]
  /** 覆盖审计所选标签；缺省视为空（旧调用方兼容） */
  coverageTags?: string[]
  /** 抽样复核配置中的标签配额；缺省视为空（旧调用方兼容） */
  sampleTargets?: SampleTarget[]
}

/** 判断规则是否引用源标签 */
function touches(rule: ConflictRule, source: string): boolean {
  return rule.tagA === source || rule.tagB === source
}

/** 两条忽略记录哪条更早：createdAt 升序，相同再按签名键字典序 */
function earlier(x: IgnoredConflict, y: IgnoredConflict): boolean {
  return (
    x.createdAt < y.createdAt ||
    (x.createdAt === y.createdAt &&
      ignoredKey(x.annotationIds, x.ruleIds) <
        ignoredKey(y.annotationIds, y.ruleIds))
  )
}

/**
 * 计算标签重命名计划。返回 null 表示参数无效（源标签当前不存在、目标为空或与源相同）。
 * 纯函数：不修改传入的任何数据，取消预览时直接丢弃计划即可。
 */
export function planTagRename(
  doc: RenamePlanInput,
  rawSource: string,
  rawTarget: string,
): TagRenamePlan | null {
  const source = normalizeTag(rawSource)
  const target = normalizeTag(rawTarget)
  if (!source || !target || source === target) return null

  const sourceExists =
    doc.annotations.some((a) => a.tags.includes(source)) ||
    doc.conflictRules.some((r) => touches(r, source)) ||
    (doc.coverageTags ?? []).includes(source)
  if (!sourceExists) return null

  // 覆盖审计所选标签：精确替换、保序去重（目标标签已在更前位置时跳过）
  const coverageTags: string[] = []
  for (const t of doc.coverageTags ?? []) {
    const v = t === source ? target : t
    if (!coverageTags.includes(v)) coverageTags.push(v)
  }

  // 抽样复核配额：标签跟随重命名；源、目标配额合并（相加），其余按标签排序
  const sampleTargetMap = new Map<string, number>()
  for (const t of doc.sampleTargets ?? []) {
    const tag = t.tag === source ? target : t.tag
    sampleTargetMap.set(tag, (sampleTargetMap.get(tag) ?? 0) + t.count)
  }
  const sampleTargets: SampleTarget[] = [...sampleTargetMap.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((x, y) => (x.tag < y.tag ? -1 : x.tag > y.tag ? 1 : 0))

  // ---------- 1. 标注标签：精确替换 + 同条去重保序 ----------

  const annotationChanges: AnnotationTagChange[] = []
  const annotations = doc.annotations.map((a) => {
    if (!a.tags.includes(source)) return a
    const next: string[] = []
    for (const t of a.tags) {
      const v = t === source ? target : t
      // 仅去掉本次替换产生的重名：目标标签已在更靠前位置出现过时跳过
      if (v === target && next.includes(target)) continue
      next.push(v)
    }
    annotationChanges.push({
      annotationId: a.id,
      quote: a.quote,
      before: [...a.tags],
      after: next,
      removedDuplicates: a.tags.length - next.length,
    })
    return { ...a, tags: next }
  })

  // ---------- 2. 规则：两端替换、自互斥删除、无序重复合并 ----------

  const ruleChanges: RuleChange[] = []
  const ruleIdMap: Record<string, string> = {}

  // 先完成两端替换；替换后两侧相同的自互斥规则直接删除
  const replaced: Array<{ original: ConflictRule; next: ConflictRule }> = []
  for (const r of doc.conflictRules) {
    if (!touches(r, source)) {
      replaced.push({ original: r, next: r })
      continue
    }
    const nextRule: ConflictRule = {
      ...r,
      tagA: r.tagA === source ? target : r.tagA,
      tagB: r.tagB === source ? target : r.tagB,
    }
    if (nextRule.tagA === nextRule.tagB) {
      ruleChanges.push({ kind: 'deleted', rule: r })
      continue
    }
    replaced.push({ original: r, next: nextRule })
  }

  // 按替换后的无序标签对分组：组内按 (createdAt, id) 取最早一条保留
  const groupOrder: string[] = []
  const groups = new Map<string, Array<{ original: ConflictRule; next: ConflictRule }>>()
  for (const item of replaced) {
    const key = rulePairKey(item.next)
    const g = groups.get(key)
    if (g) {
      g.push(item)
    } else {
      groups.set(key, [item])
      groupOrder.push(key)
    }
  }

  const rules: ConflictRule[] = []
  for (const key of groupOrder) {
    const ordered = [...groups.get(key)!].sort(
      (x, y) =>
        x.next.createdAt - y.next.createdAt ||
        (x.next.id < y.next.id ? -1 : x.next.id > y.next.id ? 1 : 0),
    )
    const winner = ordered[0]
    const survivor: ConflictRule = { ...winner.next }
    rules.push(survivor)

    const absorbedCount = ordered.length - 1

    // 被合并方：ID 映射到保留规则
    for (const loser of ordered.slice(1)) {
      ruleIdMap[loser.original.id] = survivor.id
      ruleChanges.push({ kind: 'merged', rule: loser.original, survivor })
    }

    // 保留方自身标签也被替换时记一条 changed（同时吸收了其他规则时标注数量）；
    // 保留方是未触及源标签的既有规则时不列变更明细（它在改名前就长这样）
    if (touches(winner.original, source)) {
      ruleChanges.push({
        kind: 'changed',
        rule: winner.original,
        survivor,
        absorbedCount,
      })
    }
  }

  // ---------- 3. 忽略记录：映射规则 ID → 仅保留仍命中当前冲突签名的 ----------

  const currentKeys = new Set(
    detectConflicts(annotations, rules, []).map((c) => conflictIgnoredKey(c)),
  )
  const survivingRuleIds = new Set(rules.map((r) => r.id))

  const keptByKey = new Map<string, IgnoredConflict>()
  const keyRewritten = new Map<string, boolean>()

  for (const rec of doc.ignoredConflicts) {
    const mapped: string[] = []
    let rewritten = false
    for (const rid of rec.ruleIds) {
      const m = ruleIdMap[rid] ?? rid
      if (m !== rid) rewritten = true
      if (survivingRuleIds.has(m) && !mapped.includes(m)) mapped.push(m)
    }
    // 引用的规则全部消失（自互斥删除等）→ 签名不可能再产生
    if (mapped.length === 0) continue

    mapped.sort()
    const pair = [...rec.annotationIds].sort() as [string, string]
    const candidate: IgnoredConflict = {
      annotationIds: pair,
      ruleIds: mapped,
      createdAt: rec.createdAt,
    }
    const key = ignoredKey(pair, mapped)
    // 当前冲突签名集合中已不存在（标签替换后规则不再命中）→ 清理
    if (!currentKeys.has(key)) continue

    const prev = keptByKey.get(key)
    if (!prev) {
      keptByKey.set(key, candidate)
      keyRewritten.set(key, rewritten)
    } else {
      // 多条记录映射到同一签名：保留最早一条
      const keepPrev = earlier(prev, candidate)
      keptByKey.set(key, keepPrev ? prev : candidate)
      keyRewritten.set(key, keepPrev ? keyRewritten.get(key)! : rewritten)
    }
  }

  const kept = [...keptByKey.values()].sort((x, y) => x.createdAt - y.createdAt)
  const rewrittenIgnoredCount = [...keyRewritten.values()].filter(Boolean).length
  const removedIgnoredCount = doc.ignoredConflicts.length - kept.length

  const mergedRuleCount = ruleChanges.filter((c) => c.kind === 'merged').length
  const deletedRuleCount = ruleChanges.filter((c) => c.kind === 'deleted').length

  return {
    source,
    target,
    annotations,
    rules,
    ignoredConflicts: kept,
    coverageTags,
    sampleTargets,
    annotationChanges,
    ruleChanges,
    affectedRuleCount: doc.conflictRules.filter((r) => touches(r, source)).length,
    mergedRuleCount,
    deletedRuleCount,
    ruleIdMap,
    keptIgnoredCount: kept.length,
    rewrittenIgnoredCount,
    removedIgnoredCount,
  }
}
