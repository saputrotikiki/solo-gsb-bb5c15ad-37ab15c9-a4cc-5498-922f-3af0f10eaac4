// 同引文漏标审阅
//
// 以一条【已绑定】标注为「模板」，在当前原文中枚举其引文的全部精确出现位置（含重叠出现）；
// 只有起止与出现位置【完全相同】的已绑定标注才算「已标注」（待处理不算），
// 其余出现位置即为「漏标」。勾选调标位置后可批量补建标注：
// 复制模板的标签与备注，并为各位置重新截取锚点上下文。
//
// 提交（planQuoteBackfill）时以最新文档重新核对候选位置与现有标注：
// 位置已变化（不再是引文的精确出现）或已被补过的勾选自动跳过。
//
// 纯函数模块：不修改传入数据；结果随原文、标注编辑或导入实时重算。

import type { Annotation } from '../types'
import { makeContext } from './relocation'

/** 引文在原文中的一个精确出现位置 */
export interface QuoteOccurrence {
  start: number
  end: number
  /** 是否已有起止完全相同的已绑定标注（待处理不算） */
  covered: boolean
}

/** 以某条已绑定标注为模板的漏标审阅结果 */
export interface QuoteAudit {
  templateId: string
  quote: string
  /** 全部精确出现位置（含重叠），按起点升序 */
  occurrences: QuoteOccurrence[]
  coveredCount: number
  missingCount: number
}

/** 批量补建计划 */
export interface QuoteBackfillPlan {
  templateId: string
  /** 新建标注（已复制模板标签与备注、按各位置重新截取锚点上下文） */
  created: Annotation[]
  /** 因位置已变化或已被补过而跳过的勾选位置数 */
  skippedCount: number
  /** 落地后的完整标注集（原标注顺序不变，新标注追加在末尾） */
  annotations: Annotation[]
}

/** 与 App 新建标注一致的 ID 形态 */
function makeAnnotationId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 枚举 quote 在 text 中的全部精确出现起点（允许重叠出现；空引文返回空） */
export function findQuoteOccurrences(text: string, quote: string): number[] {
  if (!quote) return []
  const out: number[] = []
  let from = 0
  for (;;) {
    const idx = text.indexOf(quote, from)
    if (idx === -1) break
    out.push(idx)
    from = idx + 1 // 允许重叠出现
  }
  return out
}

/** 起止完全相同的已绑定标注才算已标注；待处理不算 */
function coveredBy(annotations: Annotation[], start: number, end: number): boolean {
  return annotations.some(
    (a) => a.status === 'bound' && a.start === start && a.end === end,
  )
}

/**
 * 以 templateId 指定的标注为模板审计同引文漏标。
 * 模板不存在、不是已绑定或引文为空时返回 null（调用方按「模板失效」处理）。
 */
export function auditQuoteOccurrences(
  text: string,
  annotations: Annotation[],
  templateId: string,
): QuoteAudit | null {
  const template = annotations.find((a) => a.id === templateId)
  if (!template || template.status !== 'bound' || !template.quote) return null
  const quote = template.quote
  const occurrences = findQuoteOccurrences(text, quote).map((start) => {
    const end = start + quote.length
    return { start, end, covered: coveredBy(annotations, start, end) }
  })
  const coveredCount = occurrences.filter((o) => o.covered).length
  return {
    templateId,
    quote,
    occurrences,
    coveredCount,
    missingCount: occurrences.length - coveredCount,
  }
}

/**
 * 计算批量补建计划（提交时以最新文档重新核对）。对每个勾选位置逐一验证：
 *   1. 模板仍存在、已绑定且引文非空（否则整体返回 null，不落地任何变更）；
 *   2. 该位置在当前原文中仍是模板引文的精确出现（text.slice(start, end) === quote）；
 *   3. 该位置尚无起止完全相同的已绑定标注（待处理不算；已被补过的跳过）。
 * 重复勾选同一位置只补建一次（不重复计数）。通过的位置复制模板标签与备注，
 * 并按各位置重新截取锚点上下文（两侧各 CONTEXT_RADIUS 字）。
 */
export function planQuoteBackfill(
  text: string,
  annotations: Annotation[],
  templateId: string,
  positions: Array<{ start: number; end: number }>,
  now: number = Date.now(),
): QuoteBackfillPlan | null {
  const template = annotations.find((a) => a.id === templateId)
  if (!template || template.status !== 'bound' || !template.quote) return null
  const quote = template.quote

  // 已占用区间集合随创建即时更新：同一批内相同位置只补一次
  const taken = new Set(
    annotations
      .filter((a) => a.status === 'bound')
      .map((a) => `${a.start}:${a.end}`),
  )
  const seen = new Set<string>()
  const created: Annotation[] = []
  let skippedCount = 0

  for (const pos of positions) {
    const key = `${pos.start}:${pos.end}`
    if (seen.has(key)) continue // 重复勾选：静默去重，不计入跳过
    seen.add(key)

    const validRange =
      Number.isInteger(pos.start) &&
      Number.isInteger(pos.end) &&
      pos.start >= 0 &&
      pos.end > pos.start &&
      pos.end <= text.length
    // 位置已变化：不再是引文的精确出现
    if (!validRange || text.slice(pos.start, pos.end) !== quote) {
      skippedCount += 1
      continue
    }
    // 已被补过：起止完全相同的已绑定标注已存在
    if (taken.has(key)) {
      skippedCount += 1
      continue
    }

    const ctx = makeContext(text, pos.start, pos.end)
    created.push({
      id: makeAnnotationId(),
      quote,
      start: pos.start,
      end: pos.end,
      note: template.note,
      tags: [...template.tags],
      status: 'bound',
      createdAt: now,
      updatedAt: now,
      contextBefore: ctx.before,
      contextAfter: ctx.after,
    })
    taken.add(key)
  }

  return {
    templateId,
    created,
    skippedCount,
    annotations: [...annotations, ...created],
  }
}
