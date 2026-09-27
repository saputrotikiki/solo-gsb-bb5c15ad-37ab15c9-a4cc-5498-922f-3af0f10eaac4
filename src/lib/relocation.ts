import type {
  Annotation,
  RelocateReason,
  RelocationInfo,
} from '../types'

/** 绑定时截取上下文的半径（两侧字符数） */
export const CONTEXT_RADIUS = 50
/** 编辑后重定位时，在旧位置附近搜索的窗口半径（前后各 200 字） */
export const LOCAL_WINDOW = 200

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

export interface AnchorInput {
  quote: string
  start: number
  end: number
  contextBefore: string
  contextAfter: string
}

export type AnchorOutcome =
  | {
      ok: true
      start: number
      end: number
      reason: Exclude<RelocateReason, 'failed'>
      score: number
    }
  | {
      ok: false
      reason: 'failed'
      /** 待处理的具体原因，展示给用户，绝不静默误绑 */
      detail:
        | 'not-found' // 全文中找不到引文
        | 'tie' // 最高分并列
        | 'zero-score' // 评分命中但得分为 0
    }

/** 找出 needle 在 text 中的全部出现位置 */
function findAllOccurrences(text: string, needle: string): number[] {
  if (!needle) return []
  const out: number[] = []
  let from = 0
  for (;;) {
    const idx = text.indexOf(needle, from)
    if (idx === -1) break
    out.push(idx)
    from = idx + 1 // 允许重叠出现
  }
  return out
}

/**
 * 前后文相同字符数评分：
 * 取候选位置左侧与旧上文末尾连续相同的字符数，
 * 加上候选位置右侧与旧下文开头连续相同的字符数。
 */
export function contextScore(
  text: string,
  candidateStart: number,
  candidateEnd: number,
  oldBefore: string,
  oldAfter: string,
): number {
  let left = 0
  const minLeft = Math.min(oldBefore.length, candidateStart)
  while (
    left < minLeft &&
    oldBefore[oldBefore.length - 1 - left] ===
      text[candidateStart - 1 - left]
  ) {
    left++
  }

  let right = 0
  const minRight = Math.min(oldAfter.length, text.length - candidateEnd)
  while (
    right < minRight &&
    oldAfter[right] === text[candidateEnd + right]
  ) {
    right++
  }

  return left + right
}

/**
 * 按约定优先级重定位一条标注：
 * 1. 旧位置前后 200 字内精确匹配
 * 2. 全文唯一匹配
 * 3. 前后文相同字符数评分（最高分并列或得分为 0 → 待处理）
 */
export function findAnchor(text: string, a: AnchorInput): AnchorOutcome {
  const occurrences = findAllOccurrences(text, a.quote)
  if (occurrences.length === 0) return { ok: false, reason: 'failed', detail: 'not-found' }

  // 策略 1：旧位置 ±LOCAL_WINDOW 内精确匹配
  const lo = Math.max(0, a.start - LOCAL_WINDOW)
  const hi = Math.min(text.length, a.end + LOCAL_WINDOW)
  const local = occurrences.filter((p) => p >= lo && p + a.quote.length <= hi)
  if (local.length === 1) {
    return {
      ok: true,
      start: local[0],
      end: local[0] + a.quote.length,
      reason: 'local-exact',
      score: 0,
    }
  }

  // 策略 2：全文唯一匹配
  if (occurrences.length === 1) {
    return {
      ok: true,
      start: occurrences[0],
      end: occurrences[0] + a.quote.length,
      reason: 'unique',
      score: 0,
    }
  }

  // 策略 3：对所有候选做前后文评分
  let best = -1
  let bestPos: number[] = []
  for (const pos of occurrences) {
    const s = contextScore(
      text,
      pos,
      pos + a.quote.length,
      a.contextBefore,
      a.contextAfter,
    )
    if (s > best) {
      best = s
      bestPos = [pos]
    } else if (s === best) {
      bestPos.push(pos)
    }
  }

  if (best <= 0) return { ok: false, reason: 'failed', detail: 'zero-score' }
  if (bestPos.length > 1) return { ok: false, reason: 'failed', detail: 'tie' }

  return {
    ok: true,
    start: bestPos[0],
    end: bestPos[0] + a.quote.length,
    reason: 'context-score',
    score: best,
  }
}

export const REASON_LABEL: Record<RelocateReason, string> = {
  'local-exact': '原位附近精确匹配',
  unique: '全文唯一匹配',
  'context-score': '前后文评分匹配',
  failed: '未能自动重定位',
}

export const FAIL_DETAIL_LABEL: Record<string, string> = {
  'not-found': '原文中已找不到该引文，需要手动重新选择',
  tie: '多处候选的前后文评分相同，为避免误绑需人工确认',
  'zero-score': '候选位置与旧前后文没有相同字符，需人工确认',
}

/**
 * 批量重定位。返回新的标注数组：
 * - 成功：更新区间与上下文快照，写入 lastRelocation 诊断
 * - 失败：置为 pending，保留旧位置信息用于展示
 */
export function relocateAnnotations(
  annotations: Annotation[],
  newText: string,
  sourceFingerprint: string,
): Annotation[] {
  const now = Date.now()
  return annotations.map((a) => {
    const res = findAnchor(newText, {
      quote: a.quote,
      start: a.start,
      end: a.end,
      contextBefore: a.contextBefore,
      contextAfter: a.contextAfter,
    })

    const base: RelocationInfo = {
      reason: res.reason,
      score: res.ok ? res.score : 0,
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

/** 用用户重新拖选的区间完成手动绑定 */
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
