// 区间分段与配色：用端点事件扫描把标注区间切成互不重叠的文本段，
// 同一段内可能叠加多条标注

export interface TextSegment {
  start: number
  end: number
  annotationIds: string[]
}

interface Interval {
  start: number
  end: number
  id: string
}

interface SweepEvent {
  pos: number
  /** 同位置先结束后开始（半开区间 [start, end)：端点相接处旧标注退出、新标注加入） */
  type: 'end' | 'start'
  /** 区间在输入数组中的下标，同时作为活动集合的排序键 */
  index: number
}

/**
 * 事件扫描分段：标注数为 n、各段叠加标注 ID 总数为 k 时复杂度 O((n + k) log n)，
 * k 与渲染所需输出量同阶。不再对每个切分段全量回扫所有区间，
 * 标注增多时交互不被重复扫描拖慢。
 */
export function buildSegments(
  textLength: number,
  intervals: Interval[],
): TextSegment[] {
  // 忽略空区间与越界区间，顺带保留下标即输入顺序
  const events: SweepEvent[] = []
  for (let i = 0; i < intervals.length; i++) {
    const iv = intervals[i]
    if (iv.start >= 0 && iv.end <= textLength && iv.end > iv.start) {
      events.push({ pos: iv.start, type: 'start', index: i })
      events.push({ pos: iv.end, type: 'end', index: i })
    }
  }
  // 同位置先结束后开始（半开区间 [start, end)：端点相接处旧标注退出、新标注加入）；
  // 同位置同类型事件保持输入顺序（稳定排序），比较结果须满足反对称性
  events.sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos
    if (a.type !== b.type) return a.type === 'end' ? -1 : 1
    return a.index - b.index
  })

  // 活动区间下标小顶堆 + 懒删除：快照按下标升序弹出即输入顺序，
  // 用于颜色叠加与点击检查，与逐段 filter 的旧行为一致
  const activeHeap: number[] = []
  const alive = new Array<boolean>(intervals.length).fill(false)

  const heapPush = (idx: number) => {
    let k = activeHeap.push(idx) - 1
    while (k > 0) {
      const parent = (k - 1) >> 1
      if (activeHeap[parent] <= activeHeap[k]) break
      ;[activeHeap[parent], activeHeap[k]] = [activeHeap[k], activeHeap[parent]]
      k = parent
    }
  }

  // 小顶堆下沉（堆顶为给定下标）
  const siftDown = (heap: number[], k: number) => {
    for (;;) {
      const left = k * 2 + 1
      const right = left + 1
      let next = k
      if (left < heap.length && heap[left] < heap[next]) next = left
      if (right < heap.length && heap[right] < heap[next]) next = right
      if (next === k) break
      ;[heap[next], heap[k]] = [heap[k], heap[next]]
      k = next
    }
  }

  // 快照：按输入下标升序取出活动标注 ID（懒删除已结束项），
  // 随后以存活下标线性 heapify 重建活动堆
  const drainActiveIds = () => {
    const aliveIdx: number[] = []
    while (activeHeap.length > 0) {
      const idx = activeHeap[0]
      if (alive[idx]) aliveIdx.push(idx)
      const last = activeHeap.pop()!
      if (activeHeap.length > 0) {
        activeHeap[0] = last
        siftDown(activeHeap, 0)
      }
    }
    for (const idx of aliveIdx) activeHeap.push(idx)
    for (let k = (activeHeap.length >> 1) - 1; k >= 0; k--) siftDown(activeHeap, k)
    return aliveIdx.map((idx) => intervals[idx].id)
  }

  const segments: TextSegment[] = []
  let prev = 0
  let ei = 0
  while (ei < events.length) {
    const pos = events[ei].pos
    // 边界前的段 [prev, pos) 用处理该位置事件之前的活动集合
    if (pos > prev) {
      segments.push({ start: prev, end: pos, annotationIds: drainActiveIds() })
    }
    // 同位置的结束与开始事件在下一段起点前一并处理完（半开区间）
    while (ei < events.length && events[ei].pos === pos) {
      const ev = events[ei]
      if (ev.type === 'end') alive[ev.index] = false
      else {
        alive[ev.index] = true
        heapPush(ev.index)
      }
      ei += 1
    }
    prev = pos
  }
  // 尾段：补齐到原文末尾，保证 [0, textLength) 完整覆盖
  if (prev < textLength) {
    segments.push({ start: prev, end: textLength, annotationIds: drainActiveIds() })
  }
  return segments
}

// ---------- 颜色混合 ----------

const PALETTE: Array<[number, number, number]> = [
  [255, 138, 128], // red
  [255, 213, 79], // amber
  [129, 199, 132], // green
  [100, 181, 246], // blue
  [186, 104, 200], // purple
  [255, 167, 38], // orange
  [77, 208, 225], // cyan
]

export function colorForId(id: string): [number, number, number] {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function toRgb(c: [number, number, number]) {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

/**
 * 多条标注叠加：以白色为底、各颜色半透明叠加后，再按 alpha 与白底混合，
 * 输出浏览器可直接使用的 rgb()。
 */
export function blendedColor(ids: string[], alpha = 0.38): string {
  if (ids.length === 0) return 'transparent'
  if (ids.length === 1) return toRgb(colorForId(ids[0]))

  let [r, g, b]: [number, number, number] = [255, 255, 255]
  for (const id of ids) {
    const [cr, cg, cb] = colorForId(id)
    ;[r, g, b] = blendOver([r, g, b], [cr, cg, cb], alpha)
  }
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`
}

function blendOver(
  base: number[],
  over: number[],
  alpha: number,
): [number, number, number] {
  return [
    base[0] * (1 - alpha) + over[0] * alpha,
    base[1] * (1 - alpha) + over[1] * alpha,
    base[2] * (1 - alpha) + over[2] * alpha,
  ]
}

/** 单条标注的徽章底色 */
export function badgeColor(id: string): string {
  return toRgb(colorForId(id))
}
