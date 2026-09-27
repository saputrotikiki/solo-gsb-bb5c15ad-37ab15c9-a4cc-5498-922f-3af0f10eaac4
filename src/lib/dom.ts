// 把浏览器 Selection（基于 DOM 节点）换算成纯文本字符偏移

interface OffsetPoint {
  node: Node
  offset: number
}

/**
 * 计算 node 之前所有文本的字符总数。
 * root 必须是渲染原文的容器；其 textContent 应与原文逐字符一致。
 * node 为元素时，统计到其内部第一个文本节点为止，即该元素起点之前的长度。
 */
function textLengthBefore(root: HTMLElement, node: Node): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let total = 0
  let cur = walker.nextNode()
  while (cur && cur !== node && !node.contains(cur)) {
    total += (cur.textContent ?? '').length
    cur = walker.nextNode()
  }
  return total
}

/** 元素定位点：offset 是子节点索引，累计其前 offset 个子节点的文本长度 */
function childTextLength(el: Element, offset: number): number {
  let total = 0
  for (let i = 0; i < Math.min(offset, el.childNodes.length); i++) {
    total += el.childNodes[i].textContent?.length ?? 0
  }
  return total
}

function pointToOffset(root: HTMLElement, point: OffsetPoint): number {
  if (point.node.nodeType === Node.TEXT_NODE) {
    return textLengthBefore(root, point.node) + point.offset
  }
  // 元素节点（根容器、标注高亮、漏标定位内层标记等）：
  // offset 是子节点索引，在元素起点之前的长度上累计此前子节点的文本
  const base = point.node === root ? 0 : textLengthBefore(root, point.node)
  return base + childTextLength(point.node as Element, point.offset)
}

export interface DomRange {
  start: number
  end: number
}

/** 读取 root 内当前选区对应的字符区间；选区不在 root 内时返回 null */
export function selectionToOffsets(root: HTMLElement): DomRange | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null
  }
  const start = pointToOffset(root, {
    node: range.startContainer,
    offset: range.startOffset,
  })
  const end = pointToOffset(root, {
    node: range.endContainer,
    offset: range.endOffset,
  })
  if (end <= start) return null
  return { start, end }
}

/** 把字符偏移转成 DOM 定位点 */
function offsetToPoint(root: HTMLElement, target: number): OffsetPoint | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let cur = walker.nextNode()
  while (cur) {
    const len = cur.textContent?.length ?? 0
    if (target <= acc + len) {
      return { node: cur, offset: Math.max(0, target - acc) }
    }
    acc += len
    cur = walker.nextNode()
  }
  // 落在全文末尾
  const last = root.lastChild
  if (last) {
    if (last.nodeType === Node.TEXT_NODE) {
      return { node: last, offset: last.textContent?.length ?? 0 }
    }
  }
  return null
}

/** 选中 root 内指定字符区间 */
export function setSelectionRange(
  root: HTMLElement,
  start: number,
  end: number,
): boolean {
  const sp = offsetToPoint(root, start)
  const ep = offsetToPoint(root, end)
  if (!sp || !ep) return false
  const sel = window.getSelection()
  if (!sel) return false
  const range = document.createRange()
  range.setStart(sp.node, sp.offset)
  range.setEnd(ep.node, ep.offset)
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

export function clearSelection(): void {
  window.getSelection()?.removeAllRanges()
}

/** 找到包含某字符偏移的高亮元素，用于滚动定位 */
export function elementAtOffset(root: HTMLElement, offset: number): HTMLElement | null {
  const marks = root.querySelectorAll<HTMLElement>('[data-start]')
  for (const el of marks) {
    const s = Number(el.dataset.start)
    const e = Number(el.dataset.end)
    if (offset >= s && offset < e) return el
  }
  return null
}
