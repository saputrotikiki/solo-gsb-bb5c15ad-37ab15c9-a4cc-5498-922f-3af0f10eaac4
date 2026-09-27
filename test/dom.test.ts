import assert from 'node:assert'
import { JSDOM } from 'jsdom'
import { buildSegments } from '../src/lib/segments'
import { selectionToOffsets, setSelectionRange } from '../src/lib/dom'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// ---------- 分段逻辑 ----------

check('buildSegments：分段切片拼回与原文逐字符一致', () => {
  const text = '一二三四五六七八九十一二三四五六七八九十' // 20 字
  const segs = buildSegments(text.length, [
    { start: 2, end: 6, id: 'a' }, // 三四五六
    { start: 4, end: 9, id: 'b' }, // 五六七八九（与 a 重叠 4..6）
    { start: 14, end: 16, id: 'c' },
  ])
  const rejoined = segs.map((s) => text.slice(s.start, s.end)).join('')
  assert.strictEqual(rejoined, text)

  // 重叠段应携带两条标注
  const overlap = segs.find((s) => s.start === 4 && s.end === 6)!
  assert.deepStrictEqual(overlap.annotationIds.sort(), ['a', 'b'])

  // 每条标注覆盖到的区间并集应恰好等于其原区间
  for (const [id, lo, hi] of [
    ['a', 2, 6],
    ['b', 4, 9],
    ['c', 14, 16],
  ] as const) {
    const covered = segs
      .filter((s) => s.annotationIds.includes(id))
      .map((s) => [s.start, s.end] as const)
    let union = ''
    for (const [s, e] of covered) union += text.slice(s, e)
    assert.strictEqual(union, text.slice(lo, hi))
  }
})

check('buildSegments：无标注时为整段；空区间被忽略', () => {
  const segs = buildSegments(5, [{ start: 3, end: 3, id: 'x' }])
  assert.strictEqual(segs.length, 1)
  assert.deepStrictEqual(segs[0].annotationIds, [])
})

check('buildSegments：端点相接按半开区间处理，不产生叠加也不留空段', () => {
  // [0,3) 与 [3,6) 相接：同位置的结束与开始事件相抵
  const segs = buildSegments(6, [
    { start: 0, end: 3, id: 'a' },
    { start: 3, end: 6, id: 'b' },
  ])
  assert.deepStrictEqual(
    segs.map((s) => [s.start, s.end, s.annotationIds]),
    [
      [0, 3, ['a']],
      [3, 6, ['b']],
    ],
  )
})

check('buildSegments：越界区间（含负值与超出文末）被忽略', () => {
  const segs = buildSegments(5, [
    { start: -1, end: 3, id: 'neg' },
    { start: 2, end: 6, id: 'over' },
    { start: 6, end: 8, id: 'outside' },
    { start: 1, end: 4, id: 'ok' },
  ])
  const rejoined = segs.map((s) => [s.start, s.end]).join('|')
  assert.ok(rejoined.startsWith('0,1|'), `应完整覆盖原文开头：${rejoined}`)
  assert.ok(rejoined.endsWith('|4,5'), `应完整覆盖原文末尾：${rejoined}`)
  assert.deepStrictEqual(
    segs.map((s) => [s.start, s.end, s.annotationIds] as [number, number, string[]]),
    [
      [0, 1, []],
      [1, 4, ['ok']],
      [4, 5, []],
    ],
  )
})

check('buildSegments：段内标注 ID 保持输入顺序（含乱序与嵌套）', () => {
  // 旧的逐段 filter 行为：按 intervals 数组顺序收集 ID
  const segs = buildSegments(10, [
    { start: 4, end: 9, id: 'b' }, // 先输入的外层区间
    { start: 2, end: 8, id: 'a' }, // 后输入、起点更早的区间
    { start: 5, end: 6, id: 'c' },
  ])
  const idsAt = (s: number) => segs.find((seg) => seg.start === s)!.annotationIds
  assert.deepStrictEqual(idsAt(2), ['a'])
  assert.deepStrictEqual(idsAt(4), ['b', 'a']) // 重叠处保持输入顺序而非起点顺序
  assert.deepStrictEqual(idsAt(5), ['b', 'a', 'c'])
  assert.deepStrictEqual(idsAt(6), ['b', 'a'])
  assert.deepStrictEqual(idsAt(8), ['b'])
})

check('buildSegments：原文为空时结果为空数组', () => {
  assert.deepStrictEqual(buildSegments(0, []), [])
})

check('buildSegments：大量短标注下分段完整覆盖且与朴素切片结果一致', () => {
  const n = 2000
  const textLength = n * 2
  // 密集短区间：相邻相接 + 部分重叠，端点全部为整数
  const intervals = []
  for (let i = 0; i < n; i++) {
    intervals.push({ start: i * 2 % textLength, end: (i * 2 + 3) % (textLength + 1), id: `a${i}` })
  }
  const valid = intervals.filter((iv) => iv.start >= 0 && iv.end <= textLength && iv.end > iv.start)
  const segs = buildSegments(textLength, valid)

  // 首尾相接、无空洞、无空段、拼回 [0, textLength)
  assert.strictEqual(segs[0].start, 0)
  assert.strictEqual(segs[segs.length - 1].end, textLength)
  for (let i = 1; i < segs.length; i++) assert.strictEqual(segs[i].start, segs[i - 1].end)
  assert.ok(segs.every((s) => s.end > s.start))

  // 与朴素逐段全量扫描在每段 ID 集合与顺序上完全一致
  const points = new Set<number>([0, textLength])
  for (const iv of valid) {
    points.add(iv.start)
    points.add(iv.end)
  }
  const sorted = [...points].sort((x, y) => x - y)
  let segIdx = 0
  for (let i = 0; i < sorted.length - 1; i++) {
    const expectIds = valid
      .filter((iv) => iv.start <= sorted[i] && sorted[i + 1] <= iv.end)
      .map((iv) => iv.id)
    const seg = segs[segIdx++]
    assert.strictEqual(seg.start, sorted[i])
    assert.strictEqual(seg.end, sorted[i + 1])
    assert.deepStrictEqual(seg.annotationIds, expectIds)
  }
})

// ---------- jsdom：选区偏移往返 ----------

const dom = new JSDOM('<!doctype html><body><article id="root"></article></body>')
const { window } = dom
;(globalThis as unknown as { window: typeof window }).window = window
;(globalThis as unknown as { document: Document }).document = window.document
;(globalThis as unknown as { Node: typeof Node }).Node = window.Node
;(globalThis as unknown as { NodeFilter: typeof NodeFilter }).NodeFilter =
  window.NodeFilter

const doc = window.document

function render(text: string, anns: Array<[number, number, string]>) {
  const root = doc.getElementById('root') as HTMLElement
  root.innerHTML = ''
  const segs = buildSegments(
    text.length,
    anns.map(([start, end, id]) => ({ start, end, id })),
  )
  for (const seg of segs) {
    const slice = text.slice(seg.start, seg.end)
    if (seg.annotationIds.length === 0) {
      root.appendChild(doc.createTextNode(slice))
    } else {
      const mark = doc.createElement('mark')
      mark.textContent = slice
      mark.dataset.start = String(seg.start)
      mark.dataset.end = String(seg.end)
      mark.dataset.ids = seg.annotationIds.join(',')
      root.appendChild(mark)
    }
  }
  return root
}

check('selectionToOffsets：跨高亮边界的选区偏移正确', () => {
  const text = '开头平平无奇的文字中间【重点】后面又是普通文字结尾。'
  const root = render(text, [[text.indexOf('【重点】'), text.indexOf('【重点】') + 4, 'a']])

  // 从普通文本拖到 mark 内再拖出来
  const range = doc.createRange()
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let n = walker.nextNode()
  while (n) {
    nodes.push(n as Text)
    n = walker.nextNode()
  }
  // 节点结构：文本 / mark文本 / 文本
  assert.strictEqual(nodes.length, 3)
  range.setStart(nodes[0], 4) // 第一个文本节点第 4 字
  range.setEnd(nodes[2], 3) // 最后一个文本节点第 3 字
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)

  const off = selectionToOffsets(root)
  assert.ok(off)
  assert.strictEqual(text.slice(off!.start, off!.end), range.toString())
  assert.strictEqual(off!.start, 4)
  assert.strictEqual(off!.end, text.length - nodes[2].textContent!.length + 3)
})

check('setSelectionRange / selectionToOffsets：多边界点往返一致', () => {
  const text = '甲乙丙丁戊己庚辛壬癸'.repeat(4) // 40 字
  const root = render(text, [
    [3, 8, 'a'],
    [6, 12, 'b'],
    [20, 25, 'c'],
    [30, 31, 'd'],
  ])

  const points = [0, 1, 3, 5, 8, 12, 19, 20, 25, 29, 31, 39, 40]
  for (const s of points) {
    for (const e of points) {
      if (e <= s) continue
      const ok = setSelectionRange(root, s, e)
      assert.ok(ok, `设置选区 [${s}, ${e}) 应成功`)
      const back = selectionToOffsets(root)
      assert.ok(back, `读回选区 [${s}, ${e}) 应非空`)
      assert.strictEqual(back!.start, s, `起点往返 [${s}, ${e})`)
      assert.strictEqual(back!.end, e, `终点往返 [${s}, ${e})`)
      const sel = window.getSelection()!
      assert.strictEqual(sel.toString(), text.slice(s, e))
    }
  }
})

check('选区不在 root 内时返回 null', () => {
  const text = '容器内的文字'
  const root = render(text, [[1, 3, 'a']])
  const foreign = doc.createElement('div')
  doc.body.appendChild(foreign)
  foreign.textContent = '外部'
  const range = doc.createRange()
  range.selectNodeContents(foreign)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  assert.strictEqual(selectionToOffsets(root), null)
  foreign.remove()
})

// ---------- 端点落在元素子节点边界（跨多层高亮拖选） ----------

// 模拟 TextView 的真实 DOM：普通段包 span，漏标定位在段内再嵌一层 qs-range mark
function renderLikeTextView(
  text: string,
  anns: Array<[number, number, string]>,
  quoteRange: [number, number] | null,
) {
  const root = doc.getElementById('root') as HTMLElement
  root.innerHTML = ''
  const segs = buildSegments(
    text.length,
    anns.map(([start, end, id]) => ({ start, end, id })),
  )
  const fillSlice = (parent: HTMLElement, seg: { start: number; end: number }) => {
    if (!quoteRange || seg.end <= quoteRange[0] || seg.start >= quoteRange[1]) {
      parent.appendChild(doc.createTextNode(text.slice(seg.start, seg.end)))
      return
    }
    const s = Math.max(seg.start, quoteRange[0])
    const e = Math.min(seg.end, quoteRange[1])
    parent.appendChild(doc.createTextNode(text.slice(seg.start, s)))
    const qs = doc.createElement('mark')
    qs.className = 'qs-range'
    qs.dataset.start = String(s)
    qs.dataset.end = String(e)
    qs.textContent = text.slice(s, e)
    parent.appendChild(qs)
    parent.appendChild(doc.createTextNode(text.slice(e, seg.end)))
  }
  for (const seg of segs) {
    if (seg.annotationIds.length === 0) {
      const span = doc.createElement('span')
      fillSlice(span, seg)
      root.appendChild(span)
    } else {
      const mark = doc.createElement('mark')
      mark.dataset.start = String(seg.start)
      mark.dataset.end = String(seg.end)
      mark.dataset.ids = seg.annotationIds.join(',')
      fillSlice(mark, seg)
      root.appendChild(mark)
    }
  }
  return root
}

function selectAndRead(root: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection()!
  const off = selectionToOffsets(root)
  assert.ok(off, '选区应能换算成偏移')
  return off!
}

check('selectionToOffsets：端点落在高亮 mark 的子节点边界', () => {
  const text = '开头平平无奇的文字中间【重点】后面又是普通文字结尾。'
  const mStart = text.indexOf('【重点】')
  const root = render(text, [[mStart, mStart + 4, 'a']])
  const mark = root.querySelector('mark')!
  const sel = window.getSelection()!

  // 正向：从普通文本拖到 mark 结束边界 (mark, 1)
  let range = doc.createRange()
  range.setStart(root.firstChild!, 4)
  range.setEnd(mark, 1)
  sel.removeAllRanges()
  sel.addRange(range)
  let off = selectAndRead(root)
  assert.strictEqual(off.start, 4)
  assert.strictEqual(off.end, mStart + 4)
  assert.strictEqual(text.slice(off.start, off.end), sel.toString())

  // 正向：从 mark 起始边界 (mark, 0) 拖到后面普通文本
  range = doc.createRange()
  range.setStart(mark, 0)
  range.setEnd(root.childNodes[2]!, 3)
  sel.removeAllRanges()
  sel.addRange(range)
  off = selectAndRead(root)
  assert.strictEqual(off.start, mStart)
  assert.strictEqual(off.end, text.length - root.childNodes[2]!.textContent!.length + 3)
  assert.strictEqual(text.slice(off.start, off.end), sel.toString())

  // 端点落在普通段 span 的子节点边界
  const root2 = renderLikeTextView(text, [[mStart, mStart + 4, 'a']], null)
  const span = root2.querySelector('span')!
  range = doc.createRange()
  range.setStart(span, 1) // span 内文本之后 = 高亮起点
  range.setEnd(root2.childNodes[2]!.childNodes[0]!, 2)
  sel.removeAllRanges()
  sel.addRange(range)
  off = selectAndRead(root2)
  assert.strictEqual(off.start, mStart)
  assert.strictEqual(text.slice(off.start, off.end), sel.toString())
})

check('selectionToOffsets：端点落在漏标定位内层 qs-range 的子节点边界', () => {
  const text = '甲乙丙丁戊己庚辛壬癸'.repeat(2) // 20 字
  // 高亮 [4,12)，漏标定位 [6,10) 嵌在高亮内部
  const root = renderLikeTextView(text, [[4, 12, 'a']], [6, 10])
  const qs = root.querySelector('mark.qs-range')!
  const outer = root.querySelector('mark[data-ids]')!
  const sel = window.getSelection()!

  // 结构：span(0..4) / mark[data-ids](文本4..6 + qs(6..10) + 文本10..12) / span(12..20)
  // 起点落在 qs-range 起始边界 (qs, 0)，终点落在外层 mark 的子节点边界 (mark, 2)
  const range = doc.createRange()
  range.setStart(qs, 0)
  range.setEnd(outer, 2)
  sel.removeAllRanges()
  sel.addRange(range)
  const off = selectAndRead(root)
  assert.strictEqual(off.start, 6)
  assert.strictEqual(off.end, 10)
  assert.strictEqual(text.slice(off.start, off.end), sel.toString())

  // 终点落在 qs-range 结束边界 (qs, 1)
  const range2 = doc.createRange()
  range2.setStart(root.firstChild!.childNodes[0]!, 2) // 全文偏移 2
  range2.setEnd(qs, 1)
  sel.removeAllRanges()
  sel.addRange(range2)
  const off2 = selectAndRead(root)
  assert.strictEqual(off2.start, 2)
  assert.strictEqual(off2.end, 10)
  assert.strictEqual(text.slice(off2.start, off2.end), sel.toString())
})

check('selectionToOffsets：反向拖选与正向得到同一半开区间', () => {
  const text = '甲乙丙丁戊己庚辛壬癸'.repeat(2)
  const root = renderLikeTextView(text, [[4, 12, 'a']], [6, 10])
  const qs = root.querySelector('mark.qs-range')!
  const sel = window.getSelection()!

  const firstText = root.firstChild!.childNodes[0]! // span 内文本（0..4）
  const qsText = qs.firstChild! // qs-range 内文本（6..10）

  // 正向：偏移 2 → 8
  const fwd = doc.createRange()
  fwd.setStart(firstText, 2)
  fwd.setEnd(qsText, 2)
  sel.removeAllRanges()
  sel.addRange(fwd)
  const fwdOff = selectAndRead(root)
  assert.deepStrictEqual(fwdOff, { start: 2, end: 8 })

  // 反向：anchor 在偏移 8、focus 在偏移 2（从右往左拖）
  sel.removeAllRanges()
  sel.setBaseAndExtent(qsText, 2, firstText, 2)
  const backOff = selectAndRead(root)
  assert.deepStrictEqual(backOff, fwdOff)
  assert.strictEqual(sel.toString(), text.slice(2, 8))

  // 反向且端点落在元素边界：anchor=(root 末尾文本, 3)，focus=(qs, 0)
  sel.removeAllRanges()
  sel.setBaseAndExtent(root.childNodes[2]!.childNodes[0]!, 3, qs, 0)
  const backOff2 = selectAndRead(root)
  assert.deepStrictEqual(backOff2, { start: 6, end: 15 })
  assert.strictEqual(sel.toString(), text.slice(6, 15))
})

check('selectionToOffsets：根容器边界与全选行为保持不变', () => {
  const text = '根容器边界的文字'
  const root = render(text, [[2, 4, 'a']])
  const range = doc.createRange()
  range.selectNodeContents(root)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
  const off = selectAndRead(root)
  assert.deepStrictEqual(off, { start: 0, end: text.length })

  // 根容器中间子节点边界：(root, 1) → 第一个子节点之后
  const markEnd = doc.createRange()
  markEnd.setStart(root, 1)
  markEnd.setEnd(root, root.childNodes.length)
  sel.removeAllRanges()
  sel.addRange(markEnd)
  const off2 = selectAndRead(root)
  assert.strictEqual(off2.start, 2)
  assert.strictEqual(off2.end, text.length)
})

check('setSelectionRange / selectionToOffsets：嵌套漏标结构下往返一致', () => {
  const text = '甲乙丙丁戊己庚辛壬癸'.repeat(2)
  const root = renderLikeTextView(text, [[4, 12, 'a']], [6, 10])
  const points = [0, 2, 4, 6, 8, 10, 12, 15, 20]
  for (const s of points) {
    for (const e of points) {
      if (e <= s) continue
      const ok = setSelectionRange(root, s, e)
      assert.ok(ok, `设置选区 [${s}, ${e}) 应成功`)
      const back = selectionToOffsets(root)
      assert.ok(back, `读回选区 [${s}, ${e}) 应非空`)
      assert.strictEqual(back!.start, s, `起点往返 [${s}, ${e})`)
      assert.strictEqual(back!.end, e, `终点往返 [${s}, ${e})`)
      const sel = window.getSelection()!
      assert.strictEqual(sel.toString(), text.slice(s, e))
    }
  }
})

console.log(`\n全部 ${passed} 项通过`)
