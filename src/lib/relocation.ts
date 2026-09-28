import type {
  Annotation,
  RelocateReason,
  RelocationInfo,
} from '../types'

/** 绑定时截取上下文的半径（两侧字符数） */
export const CONTEXT_RADIUS = 50
/**
 * 身份判定允许的最小编辑对齐规模（old × new 片段字符数）。
 * 原文编辑器的一次改动通常只影响局部；超过该规模时无法在可接受开销内逐字符对齐，
 * 按「无法确认身份」进入待处理，绝不退化为猜测式匹配。
 */
const IDENTITY_DP_LIMIT = 4_000_000
/**
 * 判定窗口向公共前缀 / 后缀外扩的最大距离：
 * 覆盖「同一引文两处出现相距不足 200 字」的误绑场景，
 * 使被贪婪裁剪排除在外的近距同文副本也参与身份对齐。
 */
const LOCAL_GUARD = 200

/** 是否存在一处 quote 跨在偏移 boundary 两侧（起点在 boundary 前、终点在其后） */
function quoteCrossesBoundary(text: string, quote: string, boundary: number): boolean {
  const qLen = quote.length
  if (boundary <= 0 || boundary >= text.length || boundary < qLen) return false
  const from = Math.max(0, boundary - qLen + 1)
  let idx = text.indexOf(quote, from)
  while (idx !== -1 && idx < boundary) {
    if (idx + qLen > boundary) return true
    idx = text.indexOf(quote, idx + 1)
  }
  return false
}

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

/**
 * 待处理的具体原因（展示给用户，绝不静默误绑）：
 * - not-found：新原文中根本找不到该引文（原片段连同所有同文副本一起消失）
 * - identity-deleted：编辑对齐确认原标注片段被删除，现存的只是同文副本
 * - identity-ambiguous：存在两种以上同样合理的对齐方式，无法确认哪个副本是原标注
 * - edit-too-large：改动范围过大，无法在限定开销内完成身份判定
 */
export type FailDetail =
  | 'not-found'
  | 'identity-deleted'
  | 'identity-ambiguous'
  | 'edit-too-large'

export type AnchorOutcome =
  | {
      ok: true
      start: number
      end: number
      reason: 'identity-continue'
    }
  | {
      ok: false
      reason: 'failed'
      detail: FailDetail
    }

/** 找出 needle 在 text 中的全部出现位置（允许重叠） */
function findAllOccurrences(text: string, needle: string): number[] {
  if (!needle) return []
  const out: number[] = []
  let from = 0
  for (;;) {
    const idx = text.indexOf(needle, from)
    if (idx === -1) break
    out.push(idx)
    from = idx + 1
  }
  return out
}

/**
 * 前后文相同字符数评分（旧版启发式算法）。
 * 仅保留给历史行为的单元测试与诊断参考，不再参与自动绑定：
 * 同文副本相距不足一个上下文窗口时，评分无法区分「原片段」与「副本」，
 * 自动绑定必须以编辑前后的身份对齐为准。
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
 * 基于编辑前后两份原文，逐字符判定一条标注的原区间是否延续。
 *
 * 核心原则：先确认「身份」，再谈位置。设旧原文中引文段为 quote（区间 [start,end)）。
 *
 * 1. 取旧 / 新原文的最长公共前缀、后缀，把一次局部编辑夹成「旧中缀 → 新中缀」。
 * 2. 旧区间整体位于编辑区域之外（只在前方或只在后方插删），且改动内容中不含
 *    同文引文时，身份唯一确定：直接按位移量更新位置。
 * 3. 否则对中缀（并把两侧 200 字内的同文副本纳入窗口，防止贪婪裁剪遮蔽副本）
 *    做 LCS 对齐：
 *    - 恰好存在一个能在最优对齐中完整保留引文段的新位置，且不存在「丢弃引文段
 *      也同样最优」的对齐 → 原片段仍在，自动更新区间；
 *    - 没有任何最优对齐保留原引文段（原片段确认被删，现存文字只是同文副本），
 *      或存在多个同样合理的保留位置（身份无法确认）→ 进入待处理并说明原因；
 *    - 对齐规模超过上限 → 待处理，绝不退化为猜测式匹配。
 *
 * 该判定只依赖编辑前后的文本，不再使用「旧位置 ±200 字内唯一命中」这类
 * 可被近距同文副本欺骗的启发式规则。
 */
export function findAnchor(
  oldText: string,
  newText: string,
  a: AnchorInput,
): AnchorOutcome {
  const qLen = a.quote.length
  if (qLen === 0) {
    return { ok: false, reason: 'failed', detail: 'identity-ambiguous' }
  }
  if (newText.indexOf(a.quote) === -1) {
    return { ok: false, reason: 'failed', detail: 'not-found' }
  }
  if (oldText === newText) {
    if (newText.slice(a.start, a.end) === a.quote) {
      return { ok: true, reason: 'identity-continue', start: a.start, end: a.end }
    }
    return { ok: false, reason: 'failed', detail: 'identity-ambiguous' }
  }

  const oldLen = oldText.length
  // 1. 最长公共前缀 / 后缀，把这次编辑夹成「前缀 + 旧中缀→新中缀 + 后缀」的单区域改动。
  //    前缀在区间起点处截止、后缀在区间终点处截止，保证整个引文段都落在待判定区域内。
  let pre = 0
  const preMax = Math.min(oldLen, newText.length, a.start)
  while (pre < preMax && oldText[pre] === newText[pre]) pre++

  let suf = 0
  const sufMax = Math.min(
    oldLen - a.end,
    newText.length,
    oldLen - pre,
    newText.length - pre,
  )
  while (
    suf < sufMax &&
    oldText[oldLen - 1 - suf] === newText[newText.length - 1 - suf]
  ) {
    suf++
  }

  const oldMid = oldText.slice(pre, oldLen - suf)
  const newMid = newText.slice(pre, newText.length - suf)

  // 中缀边界处是否有引文跨边界出现（防止判定窗口漏掉边界上的同文副本）
  const crossesBoundary =
    quoteCrossesBoundary(newText, a.quote, pre) ||
    quoteCrossesBoundary(newText, a.quote, newText.length - suf)

  // 2. 位置快速通道：旧区间整体位于编辑区域之外（只在前方或只在后方插删）。
  //    此时身份唯一确定的前提是：被删内容与新插入内容里都不含整段引文——
  //    否则可能是「删了旧片段、在改动中放入同文副本」的障眼编辑。
  if (a.end <= pre) {
    if (
      oldMid.indexOf(a.quote) === -1 &&
      newMid.indexOf(a.quote) === -1 &&
      !crossesBoundary &&
      newText.slice(a.start, a.start + qLen) === a.quote
    ) {
      return { ok: true, reason: 'identity-continue', start: a.start, end: a.start + qLen }
    }
  } else if (a.start >= oldLen - suf) {
    const delta = newText.length - oldLen
    const ns = a.start + delta
    if (
      oldMid.indexOf(a.quote) === -1 &&
      newMid.indexOf(a.quote) === -1 &&
      !crossesBoundary &&
      ns >= 0 &&
      newText.slice(ns, ns + qLen) === a.quote
    ) {
      return { ok: true, reason: 'identity-continue', start: ns, end: ns + qLen }
    }
  }

  // 3. 区间与编辑区域相交：对中间片段做 LCS 对齐。
  //    若被裁掉的前/后缀里还躺着引文的同文副本，贪婪裁剪会把它排除在对齐之外，
  //    从而把「删原件、留副本」误判为「原件仍在」。把判定窗口向两侧外扩到
  //    最近一处同文副本之外，使所有可能混淆身份的副本都参与对齐。
  let pre0 = pre
  if (pre >= qLen) {
    const guardLo = Math.max(0, pre - LOCAL_GUARD)
    const near = oldText.lastIndexOf(a.quote, pre - qLen)
    if (near >= guardLo) pre0 = Math.min(pre0, near)
  }
  let suf0 = suf
  if (suf >= qLen) {
    const tailStart = oldLen - suf
    const guardHi = Math.min(oldLen - qLen, tailStart + LOCAL_GUARD - qLen)
    const near = oldText.indexOf(a.quote, tailStart)
    if (near !== -1 && near <= guardHi) {
      suf0 = Math.min(suf0, oldLen - (near + qLen))
    }
  }

  const A = oldText.slice(pre0, oldLen - suf0)
  const B = newText.slice(pre0, newText.length - suf0)
  const N = A.length
  const K = B.length
  // 引文段在 A 中的局部区间
  const ls = a.start - pre0
  const le = a.end - pre0

  if (N * K > IDENTITY_DP_LIMIT) {
    return { ok: false, reason: 'failed', detail: 'edit-too-large' }
  }

  // f[i][j] = LCS(A[i..], B[j..])，需要完整表格（约 N×K 个 int32）
  const f = new Int32Array((N + 1) * (K + 1))
  const idx = (i: number, j: number) => i * (K + 1) + j
  for (let i = N - 1; i >= 0; i--) {
    const ai = A[i]
    for (let j = K - 1; j >= 0; j--) {
      let v = f[idx(i + 1, j)]
      const left = f[idx(i, j + 1)]
      if (left > v) v = left
      if (ai === B[j]) {
        const diag = f[idx(i + 1, j + 1)] + 1
        if (diag > v) v = diag
      }
      f[idx(i, j)] = v
    }
  }
  const full = f[idx(0, 0)]

  // 禁止使用引文段字符做匹配时的 LCS 长度 g00。
  // g00 === full 意味着存在一个最优对齐完全不保留原引文段
  //（原片段被删，留下的同文副本由别处字符顶替）。
  let g00 = 0
  {
    const gNext = new Int32Array(K + 1)
    const gCur = new Int32Array(K + 1)
    for (let i = N - 1; i >= 0; i--) {
      const ai = A[i]
      const inSpan = i >= ls && i < le
      gCur.fill(0)
      for (let j = K - 1; j >= 0; j--) {
        let v = gNext[j] // g[i+1][j]
        const right = gCur[j + 1] // g[i][j+1]
        if (right > v) v = right
        if (!inSpan && ai === B[j]) {
          const diag = gNext[j + 1] + 1 // g[i+1][j+1]
          if (diag > v) v = diag
        }
        gCur[j] = v
      }
      gNext.set(gCur)
      if (i === 0) g00 = gCur[0]
    }
  }

  // 4. 枚举在最优对齐中可承载完整引文段的新位置 t（B 中 t 处须与 quote 逐字相同）。
  //    可承载的充要条件：LCS(A[0..ls), B[0..t)) + qLen + LCS(A[le..N), B[t+qLen..K)) === full
  const occurrences = findAllOccurrences(B, a.quote).map((t) => t + pre0)

  // 前缀 LCS：P[j] = LCS(A[0..ls), B[0..j))（滚动行）；
  // 后缀 LCS 直接复用 f 表：f[idx(le, j)] = LCS(A[le..N), B[j..K))。
  let P: Int32Array
  {
    let prev = new Int32Array(K + 1)
    for (let i = 0; i < ls; i++) {
      const cur = new Int32Array(K + 1)
      const ai = A[i]
      for (let j = 1; j <= K; j++) {
        let v = prev[j]
        if (cur[j - 1] > v) v = cur[j - 1]
        if (ai === B[j - 1]) {
          const diag = prev[j - 1] + 1
          if (diag > v) v = diag
        }
        cur[j] = v
      }
      prev = cur
    }
    P = prev
  }

  const carriers: number[] = []
  for (const pos of occurrences) {
    const t = pos - pre0
    const left = P[t]
    const right = f[idx(le, t + qLen)]
    if (left + qLen + right === full) carriers.push(pos)
  }

  if (carriers.length === 0) {
    // 没有任何最优对齐能完整保留原引文段：原片段确认被删（且无同文副本可顶替）
    return { ok: false, reason: 'failed', detail: 'identity-deleted' }
  }
  if (g00 === full || carriers.length > 1) {
    // 存在「不保留原引文段也同样最优」的对齐方式（原片段被删、现存同文副本顶替），
    // 或有多个保留位置同样合理：无法确认身份，宁可待处理也不静默误绑
    return { ok: false, reason: 'failed', detail: 'identity-ambiguous' }
  }

  const start = carriers[0]
  return {
    ok: true,
    reason: 'identity-continue',
    start,
    end: start + qLen,
  }
}

export const REASON_LABEL: Record<RelocateReason, string> = {
  'identity-continue': '原区间延续（编辑前后对齐确认）',
  failed: '未能自动重定位',
  // 旧版本遗留策略的展示文案
  'local-exact': '原位附近精确匹配（旧版策略）',
  unique: '全文唯一匹配（旧版策略）',
  'context-score': '前后文评分匹配（旧版策略）',
}

export const FAIL_DETAIL_LABEL: Record<FailDetail, string> = {
  'not-found': '原文中已找不到该引文，需要手动重新选择',
  'identity-deleted':
    '编辑前后逐字符对齐确认原标注片段已被删除；新原文中若仍有相同文字，那只是另一处同文副本，为避免误绑需手动重新选择',
  'identity-ambiguous':
    '编辑前后存在多种同样合理的对齐方式，无法确认原标注对应哪一处同文副本；需手动重新选择',
  'edit-too-large':
    '本次改动范围过大，无法逐字符确认原标注区间是否延续；需手动重新选择',
}

/**
 * 批量重定位。结合编辑前后两份原文逐条判定身份：
 * - 原片段仍在（仅位置随前后插删平移）：更新区间与上下文快照，写入 lastRelocation 诊断
 * - 原片段被删只剩同文副本 / 身份无法确认 / 引文消失：置为 pending，
 *   保留旧位置信息用于展示，pendingReason 说明具体原因
 */
export function relocateAnnotations(
  annotations: Annotation[],
  oldText: string,
  newText: string,
  sourceFingerprint: string,
): Annotation[] {
  const now = Date.now()
  return annotations.map((a) => {
    const res = findAnchor(oldText, newText, {
      quote: a.quote,
      start: a.start,
      end: a.end,
      contextBefore: a.contextBefore,
      contextAfter: a.contextAfter,
    })

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

/** 用用户重新拖选的区间完成手动绑定（待处理标注可由此恢复） */
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
