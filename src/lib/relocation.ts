import type {
  Annotation,
  RelocateReason,
  RelocationInfo,
} from '../types'

/** 绑定时截取上下文的半径（两侧字符数） */
export const CONTEXT_RADIUS = 50

export function fingerprint(text: string): string {
  // 长度 + 首尾摘要，用于判断文本是否发生过变化
  const head = text.slice(0, 32)
  const tail = text.slice(-32)
  return `${text.length}:${head}…${tail}`
}

function contextSlices(text: string, start: number, end: number) {
  return {
    before: text.slice(Math.max(0, start - CONTEXT_RADIUS), start),
    after: text.slice(end, Math.min(text.length, end + CONTEXT_RADIUS)),
  }
}

/**
 * 编辑前后两版原文之间的「单处编辑区」：
 * 设共同前缀长度 p、共同后缀长度 s，则
 *   旧文中被改写的区间为 [p, oldLen-s)，
 *   新文中替换后的区间为 [p, newLen-s)。
 * 两侧未改动的字符即标注身份可以跟随的部分；
 * 共同前缀与后缀发生交叠时（如「abc」→「xabx」一类无法唯一归并的改动）
 * 不建立映射，全部视为不可确认。
 */
export interface EditRegion {
  /** 旧文中被改写区间的起点（含） */
  oldStart: number
  /** 旧文中被改写区间的终点（不含） */
  oldEnd: number
  /** 新文中替换区间的起点（含） */
  newStart: number
  /** 新文中替换区间的终点（不含） */
  newEnd: number
  /** 共同前后缀无法唯一归并，旧位置映射整体不可信 */
  ambiguous: boolean
}

export function diffEditRegion(oldText: string, newText: string): EditRegion {
  let p = 0
  const maxPrefix = Math.min(oldText.length, newText.length)
  while (p < maxPrefix && oldText[p] === newText[p]) p++

  let s = 0
  const maxSuffix = Math.min(oldText.length - p, newText.length - p)
  while (s < maxSuffix && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) {
    s++
  }

  // 前缀与后缀交叠意味着同一批字符同时被算作前缀和后缀，
  // 无法确定编辑真正发生的位置，映射不可信。
  const ambiguous = p + s > Math.min(oldText.length, newText.length)

  return {
    oldStart: p,
    oldEnd: oldText.length - s,
    newStart: p,
    newEnd: newText.length - s,
    ambiguous,
  }
}

/**
 * 一条旧偏移量在编辑后的映射结果。
 * - mapped：该位置处在未改动的前缀 / 后缀中，可确定地映射到新偏移；
 * - inside：该位置落在被改写区间内（含其边界），原字符是否保留无法确认。
 */
export type OffsetMapping =
  | { kind: 'mapped'; offset: number }
  | { kind: 'inside' }

/** 把旧原文中的偏移量按编辑区映射到新原文 */
export function mapOffset(offset: number, region: EditRegion): OffsetMapping {
  if (region.ambiguous) return { kind: 'inside' }
  // 未改动的前缀：偏移不变
  if (offset <= region.oldStart) return { kind: 'mapped', offset }
  // 未改动的后缀：整体平移（插入时 delta>0，删除时 delta<0）
  if (offset >= region.oldEnd) {
    return { kind: 'mapped', offset: offset - region.oldEnd + region.newEnd }
  }
  return { kind: 'inside' }
}

export interface TrackInput {
  quote: string
  start: number
  end: number
}

export type TrackOutcome =
  | {
      ok: true
      start: number
      end: number
      reason: Extract<RelocateReason, 'tracked'>
    }
  | {
      ok: false
      reason: 'failed'
      /** 待处理的具体原因，展示给用户，绝不静默误绑 */
      detail:
        | 'not-found' // 新原文中已找不到该引文：原片段确认被删除
        | 'identity-lost' // 原区间被编辑触及，剩余同文副本无法确认身份
        | 'ambiguous-edit' // 前后缀交叠，无法确认标注去向
    }

function findOccurrence(text: string, needle: string, from = 0): number {
  if (!needle) return -1
  return text.indexOf(needle, from)
}

/**
 * 依据编辑前后两版原文判断一条标注的去向（身份跟随，而非文本匹配）：
 *
 * 1. 旧区间 [start,end) 完整落在未改动的前缀或后缀中
 *    （即编辑只发生在区间前方 / 后方 / 与区间不相交）→ 按偏移平移，
 *    并校验新位置仍是原引文；
 * 2. 旧区间与编辑区有交集（含端点相接的插删）：
 *    - 新原文中已不存在该引文 → 原片段被删除（not-found）；
 *    - 引文仍存在（哪怕只有一处）→ 只能说明存在同文副本，
 *      无法确认哪一处是原标注，进入待处理（identity-lost）；
 * 3. 前后缀交叠、无法唯一归并编辑区时 → 待处理（ambiguous-edit）。
 *
 * 关键区别：旧逻辑在「引文全文唯一命中」时会静默绑定，
 * 删掉已标注的那处、只剩近距离同文副本时会误绑到副本上；
 * 本逻辑只承认「原区间字符未被编辑触及」这一条身份证据。
 */
export function trackAnnotation(
  oldText: string,
  newText: string,
  a: TrackInput,
): TrackOutcome {
  const region = diffEditRegion(oldText, newText)

  if (region.ambiguous) {
    return { ok: false, reason: 'failed', detail: 'ambiguous-edit' }
  }

  const mStart = mapOffset(a.start, region)
  const mEnd = mapOffset(a.end, region)

  // 原区间完整处在未改动区域：身份确定，按偏移跟随
  if (mStart.kind === 'mapped' && mEnd.kind === 'mapped') {
    const start = mStart.offset
    const end = mEnd.offset
    // 未改动区域中的字符原样保留，新位置必然仍是原引文；
    // 再校验一次以防御脏数据（旧区间与旧原文不一致）。
    if (newText.slice(start, end) === a.quote) {
      return { ok: true, start, end, reason: 'tracked' }
    }
    // 旧区间与旧原文本身对不上：无法确认身份
    return findOccurrence(newText, a.quote) === -1
      ? { ok: false, reason: 'failed', detail: 'not-found' }
      : { ok: false, reason: 'failed', detail: 'identity-lost' }
  }

  // 旧区间被编辑触及：只报告原片段是否还存在，绝不替用户选副本
  return findOccurrence(newText, a.quote) === -1
    ? { ok: false, reason: 'failed', detail: 'not-found' }
    : { ok: false, reason: 'failed', detail: 'identity-lost' }
}

export const REASON_LABEL: Record<RelocateReason, string> = {
  tracked: '编辑前后原文比对，原位跟随',
  failed: '未能自动重定位',
  // 旧版本原因（历史数据展示用，新编辑不再产生）
  'local-exact': '原位附近精确匹配（旧版算法）',
  unique: '全文唯一匹配（旧版算法）',
  'context-score': '前后文评分匹配（旧版算法）',
}

export const FAIL_DETAIL_LABEL: Record<string, string> = {
  'not-found': '原标注片段已随编辑删除，新原文中找不到该引文，需要手动重新选择',
  'identity-lost':
    '编辑触及了原标注区间，原文中仍有相同引文但无法确认哪一处是原标注（避免误绑到同文副本），请手动确认绑定位置',
  'ambiguous-edit': '本次改动无法唯一确定编辑位置，标注去向需要手动确认',
}

/**
 * 批量重定位（身份跟随版）。返回新的标注数组：
 * - 成功：更新区间与上下文快照，写入 lastRelocation 诊断；
 * - 失败：置为 pending，保留旧位置信息用于展示；
 * - 原本就 pending 的标注不参与重定位：不做文本猜测、不静默恢复，
 *   仍可通过手动重绑恢复。
 */
export function relocateAnnotations(
  annotations: Annotation[],
  oldText: string,
  newText: string,
  sourceFingerprint: string,
): Annotation[] {
  const now = Date.now()
  return annotations.map((a) => {
    // 待处理标注的身份已无法确认，任何自动绑定都是猜测，保持待处理
    if (a.status === 'pending') return a

    const res = trackAnnotation(oldText, newText, a)

    const base: RelocationInfo = {
      reason: res.reason,
      score: 0,
      oldStart: a.start,
      oldEnd: a.end,
      sourceFingerprint,
      timestamp: now,
    }

    if (!res.ok) {
      return {
        ...a,
        status: 'pending' as const,
        lastRelocation: base,
        pendingReason: FAIL_DETAIL_LABEL[res.detail],
        updatedAt: now,
      }
    }

    const ctx = contextSlices(newText, res.start, res.end)
    return {
      ...a,
      status: 'bound' as const,
      start: res.start,
      end: res.end,
      contextBefore: ctx.before,
      contextAfter: ctx.after,
      lastRelocation: base,
      pendingReason: undefined,
      updatedAt: now,
    }
  })
}

/** 用用户重新拖选的区间完成手动绑定（待处理标注随时可由此恢复） */
export function rebindAnnotation(
  a: Annotation,
  text: string,
  start: number,
  end: number,
): Annotation {
  const now = Date.now()
  const ctx = contextSlices(text, start, end)
  return {
    ...a,
    status: 'bound',
    start,
    end,
    quote: text.slice(start, end),
    contextBefore: ctx.before,
    contextAfter: ctx.after,
    pendingReason: undefined,
    updatedAt: now,
  }
}

/** 为新标注截取上下文 */
export function makeContext(text: string, start: number, end: number) {
  return contextSlices(text, start, end)
}
