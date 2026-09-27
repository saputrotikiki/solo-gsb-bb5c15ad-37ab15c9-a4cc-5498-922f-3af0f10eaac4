// 标签覆盖审计
//
// 用户选择一组「应共同覆盖全文」的标签。仅纳入【已绑定】（区间非空）且【命中所选标签】
// 的标注，按半开区间 [start,end) 扫描全文：
//   - 覆盖数为 0 的区间记为「缺口」；
//   - 覆盖数大于 1 的区间记为「重叠」。
// 相邻且【类型】与【参与标注集合】都相同的结果合并为一条；
// 待处理标注与空区间忽略（不参与扫描）。
//
// 注意：扫描分段以全部已绑定标注（含未命中所选标签的）的端点切分，这样被未纳入标注
// 切成多段、但纳入标注集合不变的缺口 / 重叠会按规则合并回一条。

import type { Annotation } from '../types'
import { buildSegments } from './segments'
import { normalizeTag } from './conflicts'

/** 覆盖问题类型：缺口（覆盖数 0）/ 重叠（覆盖数 > 1） */
export type CoverageKind = 'gap' | 'overlap'

/** 重叠区间内的一条参与标注 */
export interface CoverageAnnotation {
  id: string
  quote: string
  tags: string[]
}

/** 一条覆盖审计结果（相邻同类型、同参与集合的区间已合并） */
export interface CoverageIssue {
  kind: CoverageKind
  start: number
  end: number
  /** 参与标注 ID，按字典序排列；缺口为空数组 */
  annotationIds: string[]
  /** 参与标注详情（缺口为空），顺序与 annotationIds 一致 */
  annotations: CoverageAnnotation[]
}

export interface CoverageResult {
  /** 按起点排列的全部问题（缺口与重叠混排） */
  issues: CoverageIssue[]
  /** 被纳入扫描的已绑定标注（命中至少一个所选标签、区间非空） */
  included: Annotation[]
  gapCount: number
  overlapCount: number
  /** 覆盖数恰好为 1 的总字符数 */
  coveredLength: number
  /** 缺口字符总数（含因相邻合并前的全部缺口段） */
  gapLength: number
  /** 按段起点标记该段所属问题的类型，供原文逐段着色 */
  marksByStart: Map<number, CoverageKind>
}

interface CoverInterval {
  start: number
  end: number
  id: string
}

/** 清洗覆盖标签集合：去空白与前导 #、去重、保序 */
export function normalizeCoverageTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const x of raw) {
    const t = normalizeTag(String(x ?? ''))
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

function sameKey(kind: CoverageKind, ids: string[]): string {
  return `${kind}:${[...ids].sort().join(',')}`
}

/**
 * 扫描全文计算覆盖结果。
 * 纯函数：不修改传入数据。selectedTags 为空时不产生任何问题。
 */
export function auditCoverage(
  annotations: Annotation[],
  textLength: number,
  rawSelectedTags: string[],
): CoverageResult {
  const selected = normalizeCoverageTags(rawSelectedTags)

  // 未选择标签 → 不进行审计（未纳入任何标注，全文也不应记为缺口）
  if (selected.length === 0) {
    return {
      issues: [],
      included: [],
      gapCount: 0,
      overlapCount: 0,
      coveredLength: 0,
      gapLength: 0,
      marksByStart: new Map(),
    }
  }

  const selectedSet = new Set(selected)

  const valid: Array<Annotation & { start: number; end: number }> = annotations.filter(
    (a) => a.status === 'bound' && a.end > a.start,
  )
  // 命中所选标签的已绑定标注才纳入覆盖统计
  const included = valid.filter((a) => a.tags.some((t) => selectedSet.has(t)))
  const intervals: CoverInterval[] = included.map((a) => ({
    start: a.start,
    end: a.end,
    id: a.id,
  }))
  const byId = new Map(included.map((a) => [a.id, a]))

  // 以全部已绑定标注端点切分：未纳入标注的端点不会改变参与集合，
  // 但切出来后可在合并阶段重新并回，保证「相邻且集合相同则合并」的语义。
  const allIntervals: CoverInterval[] = valid.map((a) => ({
    start: a.start,
    end: a.end,
    id: a.id,
  }))
  const segments = buildSegments(textLength, allIntervals)

  // 用纳入标注的起止事件维护扫描线活动集合。同一位置上 end 与 start 都在段起点前
  // 处理完毕即可——活动集合是无序 Set，同点事件先后不影响最终集合
  //（半开区间 [start,end)：端点相接处旧标注退出与新标注加入相抵）。
  const events: Array<{ pos: number; type: 'end' | 'start'; id: string }> = []
  for (const iv of intervals) {
    events.push({ pos: iv.end, type: 'end', id: iv.id })
    events.push({ pos: iv.start, type: 'start', id: iv.id })
  }
  events.sort((x, y) => x.pos - y.pos || (x.type === 'end' ? -1 : 1))

  const issues: CoverageIssue[] = []
  const marksByStart = new Map<number, CoverageKind>()
  let gapCount = 0
  let overlapCount = 0
  let coveredLength = 0
  let gapLength = 0

  // 当前正在累积的结果
  let cur:
    | { kind: CoverageKind; start: number; end: number; ids: string[] }
    | null = null

  const flush = () => {
    if (!cur) return
    const ids = cur.ids
    issues.push({
      kind: cur.kind,
      start: cur.start,
      end: cur.end,
      annotationIds: ids,
      annotations: ids.map((id) => {
        const a = byId.get(id)!
        return { id: a.id, quote: a.quote, tags: [...a.tags] }
      }),
    })
    if (cur.kind === 'gap') gapCount += 1
    else overlapCount += 1
    cur = null
  }

  // 活动集合（纳入标注）
  const active = new Set<string>()
  let eventIdx = 0
  const applyThrough = (pos: number) => {
    while (eventIdx < events.length && events[eventIdx].pos <= pos) {
      const ev = events[eventIdx]
      if (ev.type === 'end') active.delete(ev.id)
      else active.add(ev.id)
      eventIdx += 1
    }
  }

  for (const seg of segments) {
    // 段内活动集合：处理完起点处全部事件（含同点的 end 与 start）
    applyThrough(seg.start)
    const activeIds = [...active].sort()

    const kind: CoverageKind | null =
      activeIds.length === 0 ? 'gap' : activeIds.length > 1 ? 'overlap' : null

    if (kind === null) {
      flush()
      if (activeIds.length === 1) coveredLength += seg.end - seg.start
      continue
    }

    if (kind === 'gap') gapLength += seg.end - seg.start
    marksByStart.set(seg.start, kind)

    // 与上一结果相邻（段本就首尾相接）且类型、参与集合相同 → 合并
    if (cur && cur.end === seg.start && sameKey(cur.kind, cur.ids) === sameKey(kind, activeIds)) {
      cur.end = seg.end
    } else {
      flush()
      cur = { kind, start: seg.start, end: seg.end, ids: activeIds }
    }
  }
  flush()

  return {
    issues,
    included,
    gapCount,
    overlapCount,
    coveredLength,
    gapLength,
    marksByStart,
  }
}
