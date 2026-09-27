// 批量操作：按状态 / 标签 / 引文关键词组合筛选标注，并批量添加、移除标签
//
// 纯函数模块：筛选与变更计划均不修改传入数据。
// 标签落地规则（与标签重命名保持一致）：
// 1. 添加：新标签按输入顺序追加到原标签末尾；已存在的跳过 → 自动去重且原顺序不变。
// 2. 移除：删除指定标签，其余标签保持原相对顺序。
// 3. 仅真正发生标签变化的标注计入受影响数量并更新 updatedAt；其余标注原样保留。

import type { Annotation, AnnotationStatus } from '../types'
import { normalizeTag } from './conflicts'

/** 状态筛选：全部 / 仅已绑定 / 仅待处理 */
export type BulkStatusFilter = 'all' | AnnotationStatus

/** 标签命中方式：全部命中（AND）/ 任一命中（OR） */
export type BulkTagMatch = 'all' | 'any'

export interface BulkFilter {
  status: BulkStatusFilter
  tags: string[]
  tagMatch: BulkTagMatch
  /** 引文关键词（按空白裁剪；空串表示不限制），大小写不敏感的子串匹配 */
  keyword: string
}

export interface BulkTagChange {
  annotationId: string
  quote: string
  status: AnnotationStatus
  before: string[]
  after: string[]
  added: string[]
  removed: string[]
}

export interface BulkTagPlan {
  mode: 'add' | 'remove'
  /** 已归一、去重、保序的操作标签 */
  tags: string[]
  /** 被纳入操作范围的标注 ID（当前选中且仍存在的标注） */
  targetIds: string[]
  changes: BulkTagChange[]
  /** 落地后的完整标注集（顺序与输入一致） */
  annotations: Annotation[]
  affectedCount: number
}

/** 侧栏标注列表的展示顺序：已绑定按起点升序，待处理按更新时间降序 */
export function sortAnnotationsForList(annotations: Annotation[]): Annotation[] {
  return [...annotations].sort((x, y) => {
    if (x.status !== y.status) {
      return x.status === 'bound' ? -1 : 1
    }
    return x.status === 'bound' ? x.start - y.start : y.updatedAt - x.updatedAt
  })
}

/** 组合筛选：状态 + 标签（全部 / 任一）+ 引文关键词，输出按侧栏顺序排列 */
export function filterAnnotations(
  annotations: Annotation[],
  filter: BulkFilter,
): Annotation[] {
  const wanted = filter.tags
  const keyword = filter.keyword.trim().toLowerCase()
  return sortAnnotationsForList(annotations).filter((a) => {
    if (filter.status !== 'all' && a.status !== filter.status) return false
    if (wanted.length > 0) {
      const owned = new Set(a.tags)
      if (filter.tagMatch === 'all') {
        if (!wanted.every((t) => owned.has(t))) return false
      } else if (!wanted.some((t) => owned.has(t))) {
        return false
      }
    }
    if (keyword && !a.quote.toLowerCase().includes(keyword)) return false
    return true
  })
}

/**
 * 归一操作标签：逐个去空白 / 去前导 #，保序去重，丢弃空串。
 */
export function normalizeBulkTags(raw: string[]): string[] {
  const out: string[] = []
  for (const item of raw) {
    const t = normalizeTag(item)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

/** 计算一条标注添加 / 移除标签后的标签序列及增减明细 */
function applyTags(
  current: string[],
  tags: string[],
  mode: 'add' | 'remove',
): { next: string[]; added: string[]; removed: string[] } {
  if (mode === 'add') {
    const next = [...current]
    const added: string[] = []
    for (const t of tags) {
      if (!next.includes(t)) {
        next.push(t)
        added.push(t)
      }
    }
    return { next, added, removed: [] }
  }
  const remove = new Set(tags)
  const removed: string[] = []
  const next = current.filter((t) => {
    if (remove.has(t)) {
      removed.push(t)
      return false
    }
    return true
  })
  return { next, added: [], removed }
}

/**
 * 计算批量标签变更计划。返回 null 表示操作标签为空；
 * 无任何标注发生变化时返回 affectedCount 为 0 的计划（提交不改数据）。
 * 纯函数：输入数据不会被修改。
 */
export function planBulkTags(
  annotations: Annotation[],
  selectedIds: Iterable<string>,
  mode: 'add' | 'remove',
  rawTags: string[],
  now: number = Date.now(),
): BulkTagPlan | null {
  const tags = normalizeBulkTags(rawTags)
  if (tags.length === 0) return null

  const selected = new Set(selectedIds)
  const changes: BulkTagChange[] = []
  const nextAnnotations = annotations.map((a) => {
    if (!selected.has(a.id)) return a
    const { next, added, removed } = applyTags(a.tags, tags, mode)
    if (next.length === a.tags.length && next.every((t, i) => t === a.tags[i])) {
      return a
    }
    changes.push({
      annotationId: a.id,
      quote: a.quote,
      status: a.status,
      before: [...a.tags],
      after: next,
      added,
      removed,
    })
    return { ...a, tags: next, updatedAt: now }
  })

  return {
    mode,
    tags,
    targetIds: annotations.filter((a) => selected.has(a.id)).map((a) => a.id),
    changes,
    annotations: nextAnnotations,
    affectedCount: changes.length,
  }
}
