import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
;(globalThis as unknown as { window: typeof window }).window = window
;(globalThis as unknown as { document: Document }).document = window.document
;(globalThis as unknown as { navigator: Navigator }).navigator = window.navigator
;(globalThis as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement =
  window.HTMLElement
;(globalThis as unknown as { Element: typeof Element }).Element = window.Element
;(globalThis as unknown as { Node: typeof Node }).Node = window.Node
;(globalThis as unknown as { NodeFilter: typeof NodeFilter }).NodeFilter =
  window.NodeFilter
;(globalThis as unknown as { getSelection: typeof window.getSelection }).getSelection =
  window.getSelection.bind(window)
;(globalThis as unknown as { requestAnimationFrame: typeof requestAnimationFrame }).requestAnimationFrame =
  ((cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown) as typeof requestAnimationFrame
;(globalThis as unknown as { cancelAnimationFrame: typeof cancelAnimationFrame }).cancelAnimationFrame =
  ((id: number) => clearTimeout(id) as unknown) as typeof cancelAnimationFrame
;(globalThis as unknown as { localStorage: Storage }).localStorage = window.localStorage

// jsdom 不实现 scrollIntoView；覆盖审计 / 定位点击会调用它
if (typeof window.Element.prototype.scrollIntoView !== 'function') {
  window.Element.prototype.scrollIntoView = function scrollIntoView() {}
}

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { default: App } = await import('../src/App')

// 高负载机器上 React 调度与保存副作用可能晚于固定 100ms 定时器；
// 统一用「轮询直到断言成立」代替裸 setTimeout，避免环境敏感的偶发失败。
async function waitFor(
  check: () => boolean,
  { timeout = 8000, interval = 25 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const start = Date.now()
  // 先让出事件循环，触发 React 渲染与 useEffect
  await new Promise<void>((r) => setTimeout(r, 0))
  while (Date.now() - start < timeout) {
    if (check()) return
    await new Promise<void>((r) => setTimeout(r, interval))
  }
  // 最后再判定一次，不成立则抛出
  assert.ok(check(), '等待条件超时未满足')
}

/** 重新挂载后等待界面渲染出关键内容 */
async function waitMounted(el: ParentNode, token: string): Promise<void> {
  await waitFor(() => (el.textContent ?? '').includes(token) || el.innerHTML.includes(token))
}

const container = document.getElementById('root')!
const root = createRoot(container)

await new Promise<void>((resolve) => {
  root.render(
    React.createElement(React.StrictMode, null, React.createElement(App)),
  )
  setTimeout(resolve, 0)
})
await waitMounted(container, '原文锚点标注台')

const html = container.innerHTML
assert.ok(html.includes('原文锚点标注台'), '顶栏标题应渲染')
assert.ok(html.includes('粘贴'), '空文档应显示粘贴入口')
console.log('  ✓ 空文档首次渲染成功（编辑模式）')

// 模拟已保存文档 + 一条 pending 标注的渲染路径
const saved = {
  title: '测试文档',
  text: '这是一段用于渲染冒烟测试的原文，包含【重点片段】和普通文字。'.repeat(3),
  updatedAt: Date.now(),
  annotations: [
    {
      id: 'a_bound',
      quote: '重点片段',
      start: 0,
      end: 4,
      note: '备注一',
      tags: ['重点', '测试'],
      status: 'bound',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextBefore: '',
      contextAfter: '】和普通文字。',
    },
    {
      id: 'a_pending',
      quote: '已删除的引文XYZ',
      start: 100,
      end: 110,
      note: '',
      tags: [],
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextBefore: '前文',
      contextAfter: '后文',
      pendingReason: '原文中已找不到该引文，需要手动重新选择',
    },
  ],
}
// start/end 对齐到真实位置，避免高亮错位
saved.annotations[0].start = saved.text.indexOf('重点片段') - 1
saved.annotations[0].end = saved.annotations[0].start + 6

localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(saved))
// 重新挂载，让 App 从 localStorage 读取初始状态
root.unmount()
const container2 = document.createElement('div')
container2.id = 'root2'
document.body.appendChild(container2)
const root2 = createRoot(container2)

await new Promise<void>((resolve) => {
  root2.render(
    React.createElement(React.StrictMode, null, React.createElement(App)),
  )
  setTimeout(resolve, 400)
})

const html2 = container2.innerHTML
assert.ok(html2.includes('测试文档'), '应显示文档标题')
assert.ok(html2.includes('待处理'), '应渲染待处理分区')
assert.ok(html2.includes('重新选择片段'), 'pending 标注应有重绑按钮')
assert.ok(html2.includes('备注一'), '应渲染备注')
assert.ok(html2.includes('#重点'), '应渲染标签')
console.log('  ✓ 含 bound/pending 标注的文档渲染成功')

// 第三个场景：互斥规则 + 一对冲突标注 + 一条已忽略冲突
const conflictText = '甲乙丙丁戊己庚辛壬癸'.repeat(6)
const pos1 = conflictText.indexOf('丁戊')
const pos2 = conflictText.indexOf('戊己') // 与上一区间在「戊」上交叠
const savedConflicts = {
  title: '冲突文档',
  text: conflictText,
  updatedAt: Date.now(),
  annotations: [
    {
      id: 'c_pos',
      quote: conflictText.slice(pos1, pos1 + 2),
      start: pos1,
      end: pos1 + 2,
      note: '',
      tags: ['正面'],
      status: 'bound',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextBefore: '',
      contextAfter: '',
    },
    {
      id: 'c_neg',
      quote: conflictText.slice(pos2, pos2 + 2),
      start: pos2,
      end: pos2 + 2,
      note: '',
      tags: ['反面'],
      status: 'bound',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextBefore: '',
      contextAfter: '',
    },
    {
      id: 'c_ig1',
      quote: conflictText.slice(0, 3),
      start: 0,
      end: 3,
      note: '',
      tags: ['褒义'],
      status: 'bound',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextBefore: '',
      contextAfter: '',
    },
    {
      id: 'c_ig2',
      quote: conflictText.slice(1, 4),
      start: 1,
      end: 4,
      note: '',
      tags: ['贬义'],
      status: 'bound',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contextBefore: '',
      contextAfter: '',
    },
  ],
  conflictRules: [
    { id: 'rule_pn', tagA: '正面', tagB: '反面', createdAt: Date.now() },
    { id: 'rule_bd', tagA: '褒义', tagB: '贬义', createdAt: Date.now() },
  ],
  ignoredConflicts: [
    { annotationIds: ['c_ig1', 'c_ig2'], ruleIds: ['rule_bd'], createdAt: Date.now() },
  ],
}

localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(savedConflicts))
root2.unmount()
const container3 = document.createElement('div')
container3.id = 'root3'
document.body.appendChild(container3)
const root3 = createRoot(container3)

await new Promise<void>((resolve) => {
  root3.render(
    React.createElement(React.StrictMode, null, React.createElement(App)),
  )
  setTimeout(resolve, 400)
})

const html3 = container3.innerHTML
assert.ok(html3.includes('冲突审阅'), '应渲染冲突审阅分区')
assert.ok(html3.includes('正面 ⇄ 反面'), '应列出冲突命中的规则')
assert.ok(html3.includes('交叠原文'), '应展示交叠原文')
assert.ok(html3.includes('忽略此冲突'), '应提供忽略操作')
assert.ok(html3.includes('已忽略（1）'), '已忽略冲突折叠区应计数')
assert.ok(html3.includes('hl-conflict'), '未忽略冲突的交叠段应有冲突高亮类')
assert.ok(html3.includes('冲突审阅'), '顶栏应出现冲突审阅入口')
console.log('  ✓ 冲突审阅面板（含忽略折叠与交叠高亮）渲染成功')

// 标签重命名：打开弹层 → 预览 → 取消不改数据 → 再次确认后落地并写入 localStorage
{
  const renameText = '甲乙丙丁戊己庚辛壬癸'
  const renameDoc = {
    title: '重命名文档',
    text: renameText.repeat(4),
    updatedAt: Date.now(),
    annotations: [
      {
        id: 'rn_a',
        quote: '甲乙',
        start: 0,
        end: 2,
        note: '',
        tags: ['正面', '重点'],
        status: 'bound',
        createdAt: 100,
        updatedAt: 100,
        contextBefore: '',
        contextAfter: '',
      },
      {
        id: 'rn_b',
        quote: '乙丙',
        start: 1,
        end: 3,
        note: '',
        tags: ['反面'],
        status: 'bound',
        createdAt: 100,
        updatedAt: 100,
        contextBefore: '',
        contextAfter: '',
      },
    ],
    conflictRules: [
      { id: 'rn_r1', tagA: '正面', tagB: '反面', createdAt: 200 },
      { id: 'rn_r2', tagA: '正面', tagB: '其他', createdAt: 300 },
    ],
    ignoredConflicts: [
      { annotationIds: ['rn_a', 'rn_b'], ruleIds: ['rn_r1'], createdAt: 400 },
    ],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(renameDoc))
  root3.unmount()
  const c = document.createElement('div')
  c.id = 'rootrn'
  document.body.appendChild(c)
  const r = createRoot(c)

  await new Promise<void>((resolve) => {
    r.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const clickButton = (text: string) => {
    const btn = [...c.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined
    assert.ok(btn, `应存在按钮「${text}」`)
    btn!.click()
    return btn!
  }

  clickButton('标签重命名')
  await new Promise<void>((resolve) => setTimeout(resolve, 150))

  // 选择源标签 + 填写目标标签
  const select = c.querySelector('.rename-fields select') as HTMLSelectElement
  assert.ok(select, '应渲染源标签下拉框')
  select.value = '正面'
  select.dispatchEvent(new window.Event('change', { bubbles: true }))
  const input = c.querySelector('.rename-fields input') as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  setValue.call(input, '褒奖')
  input.dispatchEvent(new window.Event('input', { bubbles: true }))

  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  const previewHtml = c.innerHTML
  assert.ok(previewHtml.includes('受影响标注'), '应展示受影响标注')
  assert.ok(previewHtml.includes('褒奖 ⇄ 反面'), '预览应列出替换后的规则')

  // 取消：数据不变
  clickButton('取消')
  const afterCancel = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.deepStrictEqual(afterCancel.annotations[0].tags, ['正面', '重点'])
  assert.strictEqual(afterCancel.conflictRules[0].tagA, '正面')
  console.log('  ✓ 取消预览不改动任何数据')

  // 重新打开并确认
  clickButton('标签重命名')
  const select2 = c.querySelector('select') as HTMLSelectElement
  select2.value = '正面'
  select2.dispatchEvent(new window.Event('change', { bubbles: true }))
  const input2 = c.querySelector('.rename-fields input') as HTMLInputElement
  setValue.call(input2, '褒奖')
  input2.dispatchEvent(new window.Event('input', { bubbles: true }))
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  clickButton('确认重命名')
  await new Promise<void>((resolve) => setTimeout(resolve, 150))

  const afterApply = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.deepStrictEqual(afterApply.annotations[0].tags, ['褒奖', '重点'])
  assert.deepStrictEqual(
    afterApply.conflictRules.map((x: { tagA: string; tagB: string }) => [x.tagA, x.tagB]),
    [
      ['褒奖', '反面'],
      ['褒奖', '其他'],
    ],
  )
  // 忽略记录沿用规则 ID 且仍生效
  assert.deepStrictEqual(afterApply.ignoredConflicts[0].ruleIds, ['rn_r1'])
  assert.ok(!c.querySelector('.tag-rename-editor'), '确认后弹层关闭')
  assert.ok(c.innerHTML.includes('#褒奖'), '侧栏应显示新标签')
  console.log('  ✓ 确认重命名后标注/规则原子替换并持久化')

  r.unmount()
  c.remove()
}

// 标签覆盖审计：选择标签后实时显示缺口/重叠，点击定位，配置持久化
{
  // 0..19 共 20 字；a=[0,8) X，b=[5,12) X（与 a 重叠 [5,8)），[12,20) 为缺口
  const covText = '零一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'
  const covDoc = {
    title: '覆盖文档',
    text: covText,
    updatedAt: Date.now(),
    annotations: [
      {
        id: 'cov_a',
        quote: covText.slice(0, 8),
        start: 0,
        end: 8,
        note: '',
        tags: ['X'],
        status: 'bound',
        createdAt: 100,
        updatedAt: 100,
        contextBefore: '',
        contextAfter: '',
      },
      {
        id: 'cov_b',
        quote: covText.slice(5, 12),
        start: 5,
        end: 12,
        note: '',
        tags: ['X'],
        status: 'bound',
        createdAt: 100,
        updatedAt: 100,
        contextBefore: '',
        contextAfter: '',
      },
      {
        id: 'cov_p',
        quote: '不存在的引文ZZZ',
        start: 0,
        end: 5,
        note: '',
        tags: ['X'],
        status: 'pending',
        createdAt: 100,
        updatedAt: 100,
        contextBefore: '',
        contextAfter: '',
        pendingReason: '原文中已找不到该引文，需要手动重新选择',
      },
    ],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(covDoc))
  root3.unmount()
  const cc = document.createElement('div')
  cc.id = 'rootcov'
  document.body.appendChild(cc)
  const cr = createRoot(cc)

  await new Promise<void>((resolve) => {
    cr.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const html0 = cc.innerHTML
  assert.ok(html0.includes('标签覆盖审计'), '应渲染覆盖审计分区')
  // 未选择标签时无结果
  assert.ok(!html0.includes('cov-item'), '未选择标签时不应列出问题')

  // 点击标签 chip 选择 #X
  const chip = [...cc.querySelectorAll('.cov-tag')].find(
    (b) => b.textContent?.trim() === '#X',
  ) as HTMLButtonElement
  assert.ok(chip, '应出现标签选择按钮 #X')
  chip.click()
  await new Promise<void>((resolve) => setTimeout(resolve, 150))

  const html1 = cc.innerHTML
  assert.ok(html1.includes('缺口'), '应显示缺口结果')
  assert.ok(html1.includes('重叠'), '应显示重叠结果')
  assert.ok(html1.includes('2 条标注叠加'), '重叠卡片应列出叠加标注数')
  assert.ok(html1.includes('cov-gap'), '原文缺口段应有 cov-gap 着色')
  assert.ok(html1.includes('cov-overlap'), '原文重叠段应有 cov-overlap 着色')
  // 顶栏出现覆盖审计入口与计数（缺口 1 + 重叠 1 = 2）
  assert.ok(html1.includes('覆盖审计'), '顶栏应出现覆盖审计入口')
  // 配置已写入 localStorage
  const saved1 = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.deepStrictEqual(saved1.coverageTags, ['X'])

  // 点击重叠卡片的主体 → 区间高亮
  const overlapMain = cc.querySelector('.cov-item-overlap .cov-main') as HTMLButtonElement
  assert.ok(overlapMain, '应存在重叠结果卡片')
  overlapMain.click()
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  assert.ok(cc.innerHTML.includes('cov-active'), '点击结果后应高亮对应区间')

  // 取消选择标签 → 结果清空、持久化同步
  chip.click()
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  assert.ok(!cc.innerHTML.includes('cov-item'), '取消全部标签后问题清空')
  const saved2 = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.deepStrictEqual(saved2.coverageTags, [])
  console.log('  ✓ 标签覆盖审计：标签选择、缺口/重叠列表、原文着色、点击高亮与持久化')

  cr.unmount()
  cc.remove()
}

// 标签重命名后覆盖审计实时重算：旧标签选择自动跟随，结果仍正确
{
  const rnText = '零一二三四五六七八九十'
  const rnDoc = {
    title: '覆盖重命名',
    text: rnText,
    updatedAt: Date.now(),
    annotations: [
      {
        id: 'rnc_a',
        quote: rnText.slice(0, 5),
        start: 0,
        end: 5,
        note: '',
        tags: ['旧标签'],
        status: 'bound',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: '',
        contextAfter: '',
      },
    ],
    coverageTags: ['旧标签'],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(rnDoc))
  const c2 = document.createElement('div')
  c2.id = 'rootcovrn'
  document.body.appendChild(c2)
  const r2 = createRoot(c2)

  await new Promise<void>((resolve) => {
    r2.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  // 选集中含「旧标签」，区间 [0,5) 覆盖、[5,10) 缺口
  assert.ok(c2.innerHTML.includes('缺口'), '重命名前应有缺口（后半段未覆盖）')

  const clickButton = (text: string) => {
    const btn = [...c2.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined
    assert.ok(btn, `应存在按钮「${text}」`)
    btn.click()
  }
  clickButton('标签重命名')
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  const select = c2.querySelector('.rename-fields select') as HTMLSelectElement
  select.value = '旧标签'
  select.dispatchEvent(new window.Event('change', { bubbles: true }))
  const input = c2.querySelector('.rename-fields input') as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )!.set!
  setValue.call(input, '新标签')
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  clickButton('确认重命名')
  await new Promise<void>((resolve) => setTimeout(resolve, 150))

  const after = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.deepStrictEqual(after.coverageTags, ['新标签'], '覆盖标签集应跟随重命名')
  assert.deepStrictEqual(after.annotations[0].tags, ['新标签'])
  // 选择集跟随 → 缺口仍存在（覆盖区间不变）
  assert.ok(c2.innerHTML.includes('缺口'), '重命名后审计实时重算，缺口仍在')
  assert.ok(c2.innerHTML.includes('#新标签'), '标签选择器应显示新标签')
  console.log('  ✓ 标签重命名后覆盖审计选择集跟随并实时重算')

  r2.unmount()
  c2.remove()
}

// 快照对比：基线保存 → 删除/修改差异 → 已审签名 → 重建基线清空已审
{
  // App 中删除标注 / 重建基线走 confirm；jsdom 未实现，打桩为总是确认
  ;(globalThis as unknown as { confirm: () => boolean }).confirm = () => true
  window.confirm = () => true

  const snapText = '零一二三四五六七八九十'
  const snapDoc = {
    title: '快照文档',
    text: snapText,
    updatedAt: Date.now(),
    annotations: [
      {
        id: 'sn_a',
        quote: '零一',
        start: 0,
        end: 2,
        note: '备注A',
        tags: ['甲'],
        status: 'bound',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: '',
        contextAfter: '',
      },
      {
        id: 'sn_b',
        quote: '三四',
        start: 3,
        end: 5,
        note: '',
        tags: [],
        status: 'bound',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: '',
        contextAfter: '',
      },
    ],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(snapDoc))
  const c = document.createElement('div')
  c.id = 'rootsnap'
  document.body.appendChild(c)
  const r = createRoot(c)

  await new Promise<void>((resolve) => {
    r.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const clickButton = (text: string) => {
    const btn = [...c.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined
    assert.ok(btn, `应存在按钮「${text}」`)
    btn!.click()
    return btn!
  }
  const saved = () => JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 150))
  const doRename = async (source: string, target: string) => {
    clickButton('标签重命名')
    await wait()
    const select = c.querySelector('.rename-fields select') as HTMLSelectElement
    select.value = source
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
    const input = c.querySelector('.rename-fields input') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setValue.call(input, target)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await wait()
    clickButton('确认重命名')
    await wait()
  }

  assert.ok(c.innerHTML.includes('快照对比'), '应渲染快照对比分区')
  assert.ok(c.innerHTML.includes('保存当前为基线'), '无基线时应显示保存入口')

  // 1. 保存基线 → 无差异，基线持久化
  clickButton('保存当前为基线')
  await wait()
  assert.ok(c.innerHTML.includes('当前标注与基线一致'), '刚保存基线后应无差异')
  assert.strictEqual(saved().baseline.annotations.length, 2, '基线应含 2 条标注快照')
  assert.deepStrictEqual(saved().reviewedDiffs, [])

  // 2. 删除 sn_b → 删除差异展示基线引文；类型筛选可用
  const snbItem = [...c.querySelectorAll('.ann-item')].find((el) =>
    el.textContent?.includes('三四'),
  ) as HTMLElement
  assert.ok(snbItem, '应找到 sn_b 的标注卡片')
  const delBtn = [...snbItem.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '删除',
  ) as HTMLButtonElement
  delBtn.click()
  await wait()
  const removedCard = c.querySelector('.snap-item.snap-removed')
  assert.ok(removedCard, '应出现删除差异卡片')
  assert.ok(
    removedCard!.querySelector('.snap-quote')?.textContent?.includes('三四'),
    '删除项应展示基线引文',
  )
  assert.ok(!removedCard!.textContent?.includes('定位'), '删除项不可定位')
  // 筛选：新增类型下没有差异
  const filterAdded = [...c.querySelectorAll('.snap-filter')].find((b) =>
    b.textContent?.startsWith('新增'),
  ) as HTMLButtonElement
  filterAdded.click()
  await wait()
  assert.ok(c.innerHTML.includes('该类型下没有差异项'), '新增筛选下应无差异项')
  const filterAll = [...c.querySelectorAll('.snap-filter')].find((b) =>
    b.textContent?.startsWith('全部'),
  ) as HTMLButtonElement
  filterAll.click()
  await wait()

  // 3. 标记已审 → 以「标注 ID + 签名」持久化
  clickButton('标记已审')
  await wait()
  assert.strictEqual(saved().reviewedDiffs.length, 1, '已审记录应持久化')
  assert.strictEqual(saved().reviewedDiffs[0].annotationId, 'sn_b')
  assert.ok(saved().reviewedDiffs[0].signature.length > 0)
  assert.ok(c.innerHTML.includes('取消已审'), '已审后应可取消')

  // 4. 重建基线 → 差异清空、已审记录清空
  clickButton('重建基线')
  await wait()
  assert.ok(c.innerHTML.includes('当前标注与基线一致'), '重建基线后应无差异')
  assert.strictEqual(saved().baseline.annotations.length, 1, '基线应重建为当前 1 条标注')
  assert.deepStrictEqual(saved().reviewedDiffs, [], '重建基线应清空已审记录')

  // 5. 标签重命名 甲→乙 → 修改差异逐字段列出标签前后值
  await doRename('甲', '乙')
  const modCard = c.querySelector('.snap-item.snap-modified')
  assert.ok(modCard, '应出现修改差异卡片')
  assert.ok(modCard!.textContent?.includes('标签'), '修改项应列出标签字段')
  assert.ok(modCard!.textContent?.includes('#甲'), '修改项应列出基线标签')
  assert.ok(modCard!.textContent?.includes('#乙'), '修改项应列出当前标签')
  assert.ok(c.innerHTML.includes('条快照差异待审'), '页脚应显示待审差异数')

  // 6. 标记已审 → 持久化；内容再次变化（乙→丙）→ 重新出现为未审
  clickButton('标记已审')
  await wait()
  assert.strictEqual(saved().reviewedDiffs.length, 1)
  await doRename('乙', '丙')
  assert.deepStrictEqual(saved().reviewedDiffs, [], '签名失效的已审记录应被清理')
  assert.ok(
    c.querySelector('.snap-item.snap-modified')?.textContent?.includes('标记已审'),
    '内容再次变化后应重新出现为未审',
  )

  // 7. 恢复成基线（丙→甲）→ 差异移除
  await doRename('丙', '甲')
  assert.ok(c.innerHTML.includes('当前标注与基线一致'), '恢复成基线后差异应移除')
  assert.deepStrictEqual(saved().reviewedDiffs, [])

  r.unmount()
  c.remove()
  console.log('  ✓ 快照对比：基线、删除/修改差异、已审签名、重建清空与持久化')
}

// 抽样复核：配置（标签配额 + 种子）→ 稳定队列 → 通过/退回结论与内容变化失效
{
  const spText = '零一二三四五六七八九'
  const mk = (id: string, start: number, end: number, tags: string[]) => ({
    id,
    quote: spText.slice(start, end),
    start,
    end,
    note: '',
    tags,
    status: 'bound',
    createdAt: 1,
    updatedAt: 1,
    contextBefore: '',
    contextAfter: '',
  })
  const spDoc = {
    title: '抽样文档',
    text: spText,
    updatedAt: Date.now(),
    annotations: [
      mk('sp_a', 0, 1, ['X']),
      mk('sp_b', 1, 2, ['X', 'Y']),
      mk('sp_c', 2, 3, ['X']),
      mk('sp_d', 3, 4, ['Y']),
      mk('sp_e', 4, 5, ['Y']),
    ],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(spDoc))
  const cs = document.createElement('div')
  cs.id = 'rootsp'
  document.body.appendChild(cs)
  const sr = createRoot(cs)

  await new Promise<void>((resolve) => {
    sr.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const clickButton = (text: string) => {
    const btn = [...cs.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined
    assert.ok(btn, `应存在按钮「${text}」`)
    btn!.click()
    return btn!
  }
  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
    const proto =
      el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 150))
  const saved = () => JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)

  assert.ok(cs.innerHTML.includes('抽样复核'), '应渲染抽样复核分区')
  assert.ok(cs.querySelector('#sample-seed'), '应渲染种子输入框')

  // 顶栏在未配置时不显示计数
  const topbarBefore = cs.innerHTML
  assert.ok(topbarBefore.includes('抽样复核'), '顶栏应出现抽样复核入口')

  // 填写种子
  setNativeValue(cs.querySelector('#sample-seed') as HTMLInputElement, '固定种子')
  // 两个标签的配额输入（按标签名字典序：X、Y）
  const countInputs = [...cs.querySelectorAll('.sample-count-input')] as HTMLInputElement[]
  assert.strictEqual(countInputs.length, 2, '应为 X、Y 两个标签渲染配额输入')
  setNativeValue(countInputs[0], '2') // X
  setNativeValue(countInputs[1], '2') // Y
  await wait()
  clickButton('生成抽样队列')
  await wait()

  let persisted = saved()
  assert.ok(persisted.sampleConfig, '配置应持久化')
  assert.strictEqual(persisted.sampleConfig.seed, '固定种子')
  assert.deepStrictEqual(
    persisted.sampleConfig.targets,
    [
      { tag: 'X', count: 2 },
      { tag: 'Y', count: 2 },
    ],
  )

  // 队列：sp_b 同时命中 X/Y，贪心首轮必入选；共抽 3 条（b 同时计入两个标签）
  const cards = [...cs.querySelectorAll('.sample-item')]
  assert.strictEqual(cards.length, 3, 'X=2、Y=2 且有共享标注时应抽中 3 条')
  assert.ok(cards[0]!.textContent?.includes(spDoc.annotations[1].quote), '首条应为覆盖最多标签的 sp_b')
  // 标签配额统计：目标 / 实际 / 缺口
  assert.ok(cs.innerHTML.includes('目标'), '应展示各标签目标数')
  assert.ok(cs.innerHTML.includes('实际'), '应展示各标签实际数')
  assert.strictEqual(cs.querySelectorAll('.sample-gap-hint').length, 0, '两标签均满足时不应出现缺口提示')
  assert.ok(cs.querySelectorAll('.sample-stat-ok').length >= 2, '两个标签均应显示满额')

  // 确定性：重新挂载后队列完全一致
  sr.unmount()
  const cs2 = document.createElement('div')
  cs2.id = 'rootsp2'
  document.body.appendChild(cs2)
  const sr2 = createRoot(cs2)
  await new Promise<void>((resolve) => {
    sr2.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })
  const order1 = cards.map((c) => c.querySelector('.sample-quote')?.textContent)
  const order2 = [...cs2.querySelectorAll('.sample-item .sample-quote')].map((c) => c.textContent)
  assert.deepStrictEqual(order2, order1, '同配置重新挂载后队列必须完全相同')

  // 给首条（sp_b）填写备注并标记通过；第二条标记退回
  const cards2 = () => [...cs2.querySelectorAll('.sample-item')]
  const note0 = cards2()[0]!.querySelector('.sample-note') as HTMLTextAreaElement
  setNativeValue(note0, '复核无误')
  ;([...cards2()[0]!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '通过',
  ) as HTMLButtonElement).click()
  await wait()
  ;([...cards2()[1]!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '退回',
  ) as HTMLButtonElement).click()
  await wait()

  persisted = saved()
  assert.strictEqual(persisted.sampleReviews.length, 2, '两条结论应持久化')
  const byId = Object.fromEntries(persisted.sampleReviews.map((r: { annotationId: string }) => [r.annotationId, r]))
  assert.strictEqual(byId.sp_b.verdict, 'pass')
  assert.strictEqual(byId.sp_b.note, '复核无误')
  assert.strictEqual(byId[Object.keys(byId).find((k) => k !== 'sp_b')!].verdict, 'return')
  assert.ok(cs2.innerHTML.includes('待复核'), '仍有 1 条待复核（页脚或标题计数）')

  // 已复核项可取消
  ;([...cards2()[0]!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '通过',
  ) as HTMLButtonElement).click()
  await wait()
  assert.strictEqual(saved().sampleReviews.length, 1, '再次点击通过应取消该结论')

  // 重新标记通过，然后模拟内容变化（直接改 localStorage 中该标注的备注 → 签名失效）
  ;([...cards2()[0]!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '通过',
  ) as HTMLButtonElement).click()
  await wait()
  assert.strictEqual(saved().sampleReviews.length, 2)

  {
    const d = saved()
    const b = d.annotations.find((a: { id: string }) => a.id === 'sp_b')
    b.note = '标注内容被修改'
    d.updatedAt = Date.now()
    localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(d))
  }
  sr2.unmount()
  const cs3 = document.createElement('div')
  cs3.id = 'rootsp3'
  document.body.appendChild(cs3)
  const sr3 = createRoot(cs3)
  await new Promise<void>((resolve) => {
    sr3.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })
  const afterChange = saved()
  assert.ok(!afterChange.sampleReviews.some((r: { annotationId: string }) => r.annotationId === 'sp_b'),
    '标注内容变化后其结论应自动失效')
  assert.ok(afterChange.sampleReviews.some((r: { annotationId: string }) => r.annotationId !== 'sp_b'),
    '其他标注的结论应保留')
  // 失效项回到待复核（仍在队列中）
  assert.ok(cs3.innerHTML.includes('待复核'), '内容变化后抽中项回到待复核')
  console.log('  ✓ 抽样复核：配置持久化、稳定队列、通过/退回结论与内容变化自动失效')

  // 导入 / 导出包含配置与结论
  const exported = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.ok(exported.sampleConfig && Array.isArray(exported.sampleConfig.targets), '导出数据应含抽样配置')
  assert.ok(Array.isArray(exported.sampleReviews), '导出数据应含复核结论')

  sr3.unmount()
  cs.remove()
  cs2.remove()
  cs3.remove()
}

// 训练集划分导出：百分比校验 → 连通分组 → 统计 → 三个 JSONL 分别下载 → 确定性 → 排除待处理
{
  // jsdom 不实现 URL.createObjectURL；打桩以避免点击下载抛错
  const mockCreateObjectURL = function createObjectURL() {
    return 'blob:mock/1'
  }
  const mockRevokeObjectURL = function revokeObjectURL() {}
  ;(window.URL as unknown as { createObjectURL: typeof mockCreateObjectURL }).createObjectURL =
    mockCreateObjectURL
  ;(window.URL as unknown as { revokeObjectURL: typeof mockRevokeObjectURL }).revokeObjectURL =
    mockRevokeObjectURL
  ;(globalThis as unknown as { URL: typeof URL }).URL = window.URL

  // 包装 Blob 构造以同步捕获下载内容（app 中的 Blob 经 globalThis 解析）
  const NativeBlob = window.Blob
  const blobLog: { content: string }[] = []
  const MockBlob = function MockBlob(
    parts: BlobPart[] | undefined,
    opts?: BlobPropertyBag,
  ) {
    blobLog.push({ content: parts ? parts.map(String).join('') : '' })
    return new NativeBlob(parts as BlobPart[], opts)
  } as unknown as typeof Blob
  ;(window as unknown as { Blob: typeof Blob }).Blob = MockBlob
  ;(globalThis as unknown as { Blob: typeof Blob }).Blob = MockBlob

  const dsText = '零一二三四五六七八九十' // 10 字：10 个单字区间互不交叠
  const mk = (id: string, start: number, end: number, tags: string[] = []) => ({
    id,
    quote: dsText.slice(start, end),
    start,
    end,
    note: `备注-${id}`,
    tags,
    status: 'bound',
    createdAt: 1,
    updatedAt: 1,
    contextBefore: '',
    contextAfter: '',
  })
  // 前 4 个位置构造一条传递连通链：[0,2)∩[1,3)∩[2,4)∩[3,5) → 4 条同组；
  // 另有 6 个独立单字组，共 7 个组 / 10 条已绑定；外加 1 条 pending
  const dsDoc = {
    title: '划分文档',
    text: dsText,
    updatedAt: Date.now(),
    annotations: [
      mk('ds_a', 0, 2, ['甲']),
      mk('ds_b', 1, 3, ['乙']),
      mk('ds_c', 2, 4),
      mk('ds_d', 3, 5),
      mk('ds_e', 5, 6),
      mk('ds_f', 6, 7),
      mk('ds_g', 7, 8),
      mk('ds_h', 8, 9),
      mk('ds_i', 9, 10),
      mk('ds_j', 4, 5), // 与 ds_d=[3,5) 在 [4,5) 交叠 → 并入连通链，共 5 条同组
      {
        ...mk('ds_p', 0, 1),
        status: 'pending',
        pendingReason: '原文中已找不到该引文，需要手动重新选择',
      },
    ],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(dsDoc))
  const cd = document.createElement('div')
  cd.id = 'rootds'
  document.body.appendChild(cd)
  const dr = createRoot(cd)

  await new Promise<void>((resolve) => {
    dr.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const findButton = (text: string) =>
    [...cd.querySelectorAll('button')].find((b) =>
      b.textContent?.trim().startsWith(text),
    ) as HTMLButtonElement | undefined
  const clickButton = (text: string) => {
    const btn = findButton(text)
    assert.ok(btn, `应存在按钮「${text}」`)
    btn!.click()
    return btn!
  }
  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
    const proto = window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 150))

  assert.ok(cd.innerHTML.includes('训练集划分导出'), '应渲染训练集划分导出分区')
  clickButton('训练集划分') // 顶栏按钮（仅校验可点击/滚动不抛错）
  assert.ok(cd.querySelector('#split-seed'), '应渲染划分种子输入框')
  const percentInputs = [...cd.querySelectorAll('.split-percent-input')] as HTMLInputElement[]
  assert.strictEqual(percentInputs.length, 3, '应渲染 train/validation/test 三个百分比输入')
  assert.ok(cd.textContent!.includes('待处理标注被排除'), '应提示待处理标注被排除')

  // 1. 非法百分比（合计 90）→ 错误提示，按钮禁用
  setNativeValue(percentInputs[0], '80')
  setNativeValue(percentInputs[1], '10')
  setNativeValue(percentInputs[2], '0')
  await wait()
  assert.ok(cd.textContent!.includes('合计须为 100'), '合计不为 100 时应显示错误')
  assert.ok(
    (findButton('计算划分') as HTMLButtonElement).disabled,
    '百分比非法时计算按钮应禁用',
  )

  // 2. 恢复 80/10/10 并计算：6 个组 → 4/1/1（贪心按组分配）
  setNativeValue(percentInputs[2], '10')
  await wait()
  assert.ok(!cd.textContent!.includes('合计须为 100'))
  const seedEl = cd.querySelector('#split-seed') as HTMLInputElement
  setNativeValue(seedEl, '固定划分种子')
  await wait()
  clickButton('计算划分')
  await wait()

  const cdText = () => cd.textContent ?? ''
  assert.ok(cdText().includes('6 个连通组'), `应报告 6 个连通组：${cdText().slice(0, 400)}`)
  assert.ok(cdText().includes('10 条已绑定标注'), '应报告 10 条已绑定标注')
  assert.ok(cdText().includes('排除待处理'), '应显示排除数')
  assert.ok(/排除待处理\s*1\s*条/.test(cdText()), '排除数应为 1')

  const readStats = () => {
    const out: Record<string, { groups: number; anns: number }> = {}
    for (const card of [...cd.querySelectorAll('.split-stat-card')]) {
      const name = (card.querySelector('.split-stat-key') as HTMLElement).textContent!.trim()
      const nums = [...card.querySelectorAll('.split-stat-nums > span strong')].map((e) =>
        Number(e.textContent),
      )
      out[name] = { groups: nums[0], anns: nums[1] }
    }
    return out
  }
  const stats = readStats()
  assert.strictEqual(stats.train.groups + stats.validation.groups + stats.test.groups, 6)
  assert.strictEqual(stats.train.anns + stats.validation.anns + stats.test.anns, 10)
  // 6 组（5 + 1×5）、80/10/10 的贪心结果为 4/1/1
  assert.deepStrictEqual(
    { train: stats.train.groups, validation: stats.validation.groups, test: stats.test.groups },
    { train: 4, validation: 1, test: 1 },
  )
  // 五标注连通链必须整体在同一集合
  let chainDataset = ''
  for (const line of cd.querySelectorAll('.split-group-item')) {
    const ids = [...line.querySelectorAll('.split-group-ann-id')].map((e) => e.textContent)
    if (ids.includes('ds_a')) {
      assert.deepStrictEqual(ids, ['ds_a', 'ds_b', 'ds_c', 'ds_d', 'ds_j'])
      chainDataset = 'found'
    }
  }
  assert.strictEqual(chainDataset, 'found', '明细中应展示 5 标注连通链整组')

  // 三个下载按钮均存在：train 4 行、validation 1 行、test 1 行
  assert.ok(findButton('下载 train.jsonl'), '应有 train 下载按钮')
  assert.ok(findButton('下载 validation.jsonl'), '应有 validation 下载按钮')
  const testBtn = findButton('下载 test.jsonl')!
  assert.ok(!testBtn.disabled, 'test 有 1 组时下载按钮应可用')

  // 3. 下载 train JSONL：每组一行，字段齐全，且 pending 标注绝不出现
  blobLog.length = 0
  clickButton('下载 train.jsonl')
  await wait()
  assert.strictEqual(blobLog.length, 1, '点击下载应产生一个 Blob')
  const trainJsonl = blobLog[0]!.content
  const trainLines = trainJsonl.split('\n').filter(Boolean)
  assert.strictEqual(trainLines.length, stats.train.groups, 'train JSONL 行数 = train 组数')
  const trainRows = trainLines.map((l) => JSON.parse(l))
  for (const row of trainRows) {
    assert.strictEqual(row.title, '划分文档')
    assert.strictEqual(row.text, dsText)
    assert.strictEqual(row.dataset, 'train')
    assert.ok(Array.isArray(row.group.annotationIds) && row.group.annotationIds.length > 0)
    for (const a of row.group.annotations) {
      assert.ok(typeof a.position.start === 'number')
      assert.ok(typeof a.quote === 'string')
      assert.ok(Array.isArray(a.tags))
      assert.ok(typeof a.note === 'string')
    }
  }
  assert.ok(!trainJsonl.includes('ds_p'), '待处理标注不得出现在导出中')
  // 连通链整组出现在某一行（且只出现一次）
  const chainLineCount = trainRows.filter((r) =>
    r.group.annotationIds.includes('ds_a'),
  ).length
  const chainInTrain = chainLineCount === 1
  let chainKeptAtomic = true
  for (const row of trainRows) {
    const ids = row.group.annotationIds
    if (ids.includes('ds_a')) {
      chainKeptAtomic =
        ids.includes('ds_b') && ids.includes('ds_c') && ids.includes('ds_d') && ids.includes('ds_j')
    }
  }
  assert.ok(chainInTrain && chainKeptAtomic, '连通链应整组出现在 train 的同一行')

  // 下载 validation
  blobLog.length = 0
  clickButton('下载 validation.jsonl')
  await wait()
  const valLines = blobLog[0]!.content.split('\n').filter(Boolean)
  assert.strictEqual(valLines.length, stats.validation.groups)
  assert.strictEqual(JSON.parse(valLines[0]!).dataset, 'validation')

  // 4. 确定性：相同种子 / 百分比 / 标注集，重新挂载后划分完全一致
  dr.unmount()
  const cd2 = document.createElement('div')
  cd2.id = 'rootds2'
  document.body.appendChild(cd2)
  const dr2 = createRoot(cd2)
  await new Promise<void>((resolve) => {
    dr2.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })
  const inputs2 = [...cd2.querySelectorAll('.split-percent-input')] as HTMLInputElement[]
  setNativeValue(inputs2[0], '80')
  setNativeValue(inputs2[1], '10')
  setNativeValue(inputs2[2], '10')
  setNativeValue(cd2.querySelector('#split-seed') as HTMLInputElement, '固定划分种子')
  await wait()
  ;([...cd2.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '计算划分',
  ) as HTMLButtonElement).click()
  await wait()
  const stats2 = (() => {
    const out: Record<string, { groups: number; anns: number }> = {}
    for (const card of [...cd2.querySelectorAll('.split-stat-card')]) {
      const name = (card.querySelector('.split-stat-key') as HTMLElement).textContent!.trim()
      const nums = [...card.querySelectorAll('.split-stat-nums > span strong')].map((e) =>
        Number(e.textContent),
      )
      out[name] = { groups: nums[0], anns: nums[1] }
    }
    return out
  })()
  assert.deepStrictEqual(stats2, stats, '相同输入重新挂载后统计必须一致')

  // 5. 10 个独立组（无交叠、无 pending）时 80/10/10 → 8/1/1，三个文件都可下载
  const soloDoc = {
    title: '独立组文档',
    text: dsText,
    updatedAt: Date.now(),
    annotations: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => mk(`so_${i}`, i, i + 1)),
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(soloDoc))
  dr2.unmount()
  const cd3 = document.createElement('div')
  cd3.id = 'rootds3'
  document.body.appendChild(cd3)
  const dr3 = createRoot(cd3)
  await new Promise<void>((resolve) => {
    dr3.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })
  const inputs3 = [...cd3.querySelectorAll('.split-percent-input')] as HTMLInputElement[]
  setNativeValue(inputs3[0], '80')
  setNativeValue(inputs3[1], '10')
  setNativeValue(inputs3[2], '10')
  await wait()
  ;([...cd3.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '计算划分',
  ) as HTMLButtonElement).click()
  await wait()
  assert.ok(cd3.textContent!.includes('10 个连通组'))
  assert.ok(!cd3.textContent!.includes('待处理标注被排除'), '无 pending 时不显示排除提示')
  assert.ok(!cd3.textContent!.includes('排除待处理'))
  const testBtn3 = [...cd3.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('下载 test.jsonl'),
  ) as HTMLButtonElement
  assert.ok(!testBtn3.disabled, 'test 有 1 组时下载按钮应可用')
  blobLog.length = 0
  testBtn3.click()
  await wait()
  const testLines = blobLog[0]!.content.split('\n').filter(Boolean)
  assert.strictEqual(testLines.length, 1)
  assert.strictEqual(JSON.parse(testLines[0]!).dataset, 'test')
  console.log('  ✓ 训练集划分导出：校验、连通分组、统计、JSONL 下载、确定性与待处理排除')

  dr3.unmount()
  cd.remove()
  cd2.remove()
  cd3.remove()
}

// 批量操作：组合筛选 → 全选 / 反选 → 预览 → 取消不改数据 → 确认一次性更新（保序去重）→ 刷新一致
{
  const bulkText = '好评如潮差评平平好评结尾' // 10 字
  const bk = (id: string, start: number, end: number, tags: string[], quote?: string, status: 'bound' | 'pending' = 'bound') => ({
    id,
    quote: quote ?? bulkText.slice(start, end),
    start,
    end,
    note: '',
    tags,
    status,
    createdAt: 1,
    updatedAt: 1,
    contextBefore: '',
    contextAfter: '',
    ...(status === 'pending'
      ? { pendingReason: '原文中已找不到该引文，需要手动重新选择' }
      : {}),
  })
  const bulkDoc = {
    title: '批量文档',
    text: bulkText,
    updatedAt: Date.now(),
    annotations: [
      bk('bk_a', 0, 2, ['正面']), // 好评
      bk('bk_b', 4, 6, ['正面', '重点']), // 好评（位置 4,5）
      bk('bk_c', 2, 4, ['反面']), // 差评
      bk('bk_d', 6, 8, ['正面'], '旧引文XYZ', 'pending'),
    ],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(bulkDoc))
  const bc = document.createElement('div')
  bc.id = 'rootbulk'
  document.body.appendChild(bc)
  const br = createRoot(bc)

  await new Promise<void>((resolve) => {
    br.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const section = () => bc.querySelector('.bulk-section') as HTMLElement
  assert.ok(section(), '应渲染批量操作分区')
  const clickButton = (text: string, root: ParentNode = bc) => {
    const btn = [...root.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined
    assert.ok(btn, `应存在按钮「${text}」`)
    btn!.click()
    return btn!
  }
  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 150))
  const saved = () => JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)

  // 初始：匹配全部 4 条
  assert.ok(section()!.textContent!.includes('匹配'), '应显示匹配数量')
  assert.ok(/匹配\s*<strong>4<\/strong>/.test(section()!.innerHTML), '初始应匹配 4 条')

  // 状态筛选：已绑定 → 3 条
  clickButton('已绑定', section()!)
  await wait()
  assert.strictEqual(section()!.querySelectorAll('.bulk-item').length, 3, '已绑定应匹配 3 条')

  // 标签筛选：#正面（默认全部命中）→ bk_a、bk_b
  ;([...section()!.querySelectorAll('.cov-tag')].find(
    (b) => b.textContent?.trim() === '#正面',
  ) as HTMLButtonElement).click()
  await wait()
  let rows = [...section()!.querySelectorAll('.bulk-item')]
  assert.strictEqual(rows.length, 2, '已绑定 + #正面 应匹配 2 条')

  // 切换任一命中并加选 #反面 → bk_a、bk_b、bk_c（任一命中）；#正面 已选，点 #反面
  clickButton('任一命中', section()!)
  await wait()
  ;([...section()!.querySelectorAll('.cov-tag')].find(
    (b) => b.textContent?.trim() === '#反面',
  ) as HTMLButtonElement).click()
  await wait()
  assert.strictEqual(section()!.querySelectorAll('.bulk-item').length, 3, '任一命中应匹配 3 条')

  // 关键词「差评」→ 仅 bk_c
  setNativeValue(section()!.querySelector('#bulk-keyword') as HTMLInputElement, '差评')
  await wait()
  rows = [...section()!.querySelectorAll('.bulk-item')]
  assert.strictEqual(rows.length, 1, '关键词应收窄到 1 条')
  assert.ok(rows[0]!.textContent!.includes('差评'), '匹配项应是 bk_c')

  // 无匹配提示：再叠加状态「待处理」
  clickButton('待处理', section()!)
  await wait()
  assert.strictEqual(section()!.querySelectorAll('.bulk-item').length, 0, '应无匹配')
  assert.ok(section()!.textContent!.includes('没有匹配的标注'), '无匹配时应提示且不改数据')
  // 全选按钮禁用
  assert.ok(
    ([...section()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === '全选') as HTMLButtonElement).disabled,
    '无匹配时全选应禁用',
  )

  // 清空筛选 → 回到 4 条
  clickButton('清空筛选', section()!)
  await wait()
  assert.strictEqual(section()!.querySelectorAll('.bulk-item').length, 4, '清空后应匹配全部')

  // 全选 4 条 → 反选 → 0 条 → 再全选
  clickButton('全选', section()!)
  await wait()
  assert.ok(section()!.textContent!.includes('已选 4 条'), '全选后应显示已选 4 条')
  assert.strictEqual(section()!.querySelectorAll('.bulk-item-on').length, 4)
  clickButton('反选', section()!)
  await wait()
  assert.strictEqual(section()!.querySelectorAll('.bulk-item-on').length, 0, '反选后应 0 条选中')
  clickButton('全选', section()!)
  await wait()

  // 进入添加预览：取消 → 数据不变
  clickButton('添加标签', section()!)
  await wait()
  assert.ok(section()!.textContent!.includes('批量添加标签'), '应进入添加预览')
  // 输入已存在的标签：所有标注都含「正面」？bk_c 不含、bk_d 不含 → 仍有变化
  setNativeValue(
    section()!.querySelector('.bulk-preview .tag-chips input') as HTMLInputElement,
    '正面,',
  )
  await wait()
  assert.ok(section()!.textContent!.includes('将更新'), '应显示将更新数量')
  const skipHint = [...section()!.querySelectorAll('.bulk-preview-count')].some((e) =>
    e.textContent?.includes('无变化将跳过'),
  )
  assert.ok(skipHint, 'bk_a/bk_b 已含正面，应提示无变化跳过条数')
  clickButton('取消', section()!)
  await wait()
  const afterCancel = saved()
  assert.deepStrictEqual(
    afterCancel.annotations.map((a: { tags: string[] }) => a.tags),
    bulkDoc.annotations.map((a) => a.tags),
    '取消预览不应改动数据',
  )

  // 移除标签：全选 → 移除「正面」，预览中 bk_a / bk_b / bk_d 变化（3 条），bk_c 跳过
  clickButton('移除标签', section()!)
  await wait()
  assert.ok(section()!.textContent!.includes('批量移除标签'), '应进入移除预览')
  setNativeValue(
    section()!.querySelector('.bulk-preview .tag-chips input') as HTMLInputElement,
    '正面,',
  )
  await wait()
  assert.ok(section()!.textContent!.includes('选中 4 条'), '预览应显示选中数')
  assert.ok(section()!.innerHTML.includes('bulk-tag-del'), '被移除标签应以删除样式标出')
  const previewRows = section()!.querySelectorAll('.bulk-preview-row')
  assert.strictEqual(previewRows.length, 3, '仅 3 条实际持有正面标签')
  const confirmBtn = [...section()!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim().startsWith('确认更新'),
  ) as HTMLButtonElement
  assert.ok(confirmBtn.textContent?.includes('3 条'), '确认按钮应标注更新 3 条')
  confirmBtn.click()
  await wait()

  const after = saved()
  assert.deepStrictEqual(
    after.annotations.map((a: { tags: string[] }) => a.tags),
    [[], ['重点'], ['反面'], []],
    '移除应只删正面且保留其余标签原顺序',
  )
  assert.ok(
    after.annotations.every((a: { updatedAt: number }) => typeof a.updatedAt === 'number'),
  )
  // bk_c 未变化：updatedAt 保持 1
  assert.strictEqual(after.annotations[2].updatedAt, 1, '未变化标注 updatedAt 不动')
  assert.ok(section()!.textContent!.includes('更新 3 条标注'), '完成后应给出受影响数量提示')
  // 操作后筛选列表仍在（筛选条件保留），勾选清空
  assert.strictEqual(section()!.querySelectorAll('.bulk-item-on').length, 0, '提交后勾选应清空')
  assert.strictEqual(section()!.querySelectorAll('.bulk-item').length, 4, '提交后仍展示匹配结果')

  // 刷新（重新挂载）后数据保持一致
  br.unmount()
  const bc2 = document.createElement('div')
  bc2.id = 'rootbulk2'
  document.body.appendChild(bc2)
  const br2 = createRoot(bc2)
  await new Promise<void>((resolve) => {
    br2.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })
  const reparsed2 = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.deepStrictEqual(
    reparsed2.annotations.map((a: { tags: string[] }) => a.tags),
    [[], ['重点'], ['反面'], []],
    '刷新后批量更新结果保持一致',
  )
  // 导入导出：标签数据位于 annotations.tags，随既有导入导出链路保持
  const exported = reparsed2
  assert.ok(Array.isArray(exported.annotations[1].tags), '导出数据应含更新后的标签')
  assert.deepStrictEqual(exported.annotations[1].tags, ['重点'])
  console.log('  ✓ 批量操作：组合筛选、全选反选、预览取消、一次性更新保序去重、提示与刷新一致')

  br2.unmount()
  bc.remove()
  bc2.remove()
}

// 审阅报告：侧栏按钮基于当前快照下载自包含 HTML，不修改本地数据；文件名含标题与日期
{
  const repText = '甲乙丙丁戊己庚辛壬癸'
  const repDoc = {
    title: '报告测试文档',
    text: repText,
    updatedAt: Date.now(),
    annotations: [
      {
        id: 'rep_a',
        quote: repText.slice(0, 3),
        start: 0,
        end: 3,
        note: '报告备注',
        tags: ['正面'],
        status: 'bound',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: '',
        contextAfter: '',
      },
      {
        id: 'rep_b',
        quote: repText.slice(2, 5),
        start: 2,
        end: 5,
        note: '',
        tags: ['反面'],
        status: 'bound',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: '',
        contextAfter: '',
      },
      {
        id: 'rep_p',
        quote: '消失的引文ZZZ',
        start: 0,
        end: 0,
        note: '',
        tags: [],
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: '',
        contextAfter: '',
        pendingReason: '原文中已找不到该引文，需要手动重新选择',
      },
    ],
    conflictRules: [{ id: 'rep_r1', tagA: '正面', tagB: '反面', createdAt: 1 }],
    ignoredConflicts: [],
    coverageTags: ['正面'],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(repDoc))
  const rc = document.createElement('div')
  rc.id = 'rootrep'
  document.body.appendChild(rc)
  const rr = createRoot(rc)

  await new Promise<void>((resolve) => {
    rr.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const sideHtml = rc.innerHTML
  assert.ok(sideHtml.includes('审阅报告'), '侧栏应渲染审阅报告分区')
  assert.ok(sideHtml.includes('生成并下载 HTML 报告'), '应有下载按钮')
  // 侧栏内联汇总：标注 3、待处理 1、冲突 1、覆盖问题 1（[3,10) 缺口）
  const summary = rc.querySelector('.report-summary')!.textContent!
  assert.ok(/标注\s*3/.test(summary))
  assert.ok(/待处理\s*1/.test(summary))
  assert.ok(/冲突\s*1/.test(summary))
  assert.ok(/覆盖问题\s*1/.test(summary))

  // 捕获下载：Blob 内容 + 锚点 download 文件名
  const NativeBlob2 = window.Blob
  const captured: { content: string; filename: string }[] = []
  const CaptureBlob = function CaptureBlob(
    parts: BlobPart[] | undefined,
    opts?: BlobPropertyBag,
  ) {
    captured.push({ content: parts ? parts.map(String).join('') : '', filename: '' })
    return new NativeBlob2(parts as BlobPart[], opts)
  } as unknown as typeof Blob
  ;(window as unknown as { Blob: typeof Blob }).Blob = CaptureBlob
  ;(globalThis as unknown as { Blob: typeof Blob }).Blob = CaptureBlob
  ;(window.URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
    'blob:mock/report'
  ;(window.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
  const nativeClick = window.HTMLElement.prototype.click
  window.HTMLElement.prototype.click = function click(this: HTMLElement) {
    if (this.tagName === 'A' && this.getAttribute('download')) {
      captured[captured.length - 1]!.filename = this.getAttribute('download')!
      return
    }
    return nativeClick.call(this)
  }

  const before = localStorage.getItem('anchor-annotation-console:v1')!
  ;([...rc.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '生成并下载 HTML 报告',
  ) as HTMLButtonElement).click()
  await new Promise<void>((resolve) => setTimeout(resolve, 150))

  assert.strictEqual(captured.length, 1, '点击应产生一个下载 Blob')
  const reportHtml = captured[0]!.content
  assert.ok(reportHtml.startsWith('<!doctype html>'), '下载内容应为完整 HTML 文档')
  assert.ok(reportHtml.includes('<style>'), '报告应内嵌样式（自包含）')
  assert.ok(reportHtml.includes('报告测试文档'), '报告应含文档标题')
  assert.ok(reportHtml.includes('报告备注'), '报告应含标注备注')
  assert.ok(reportHtml.includes('rep-hl-conflict'), '报告应渲染冲突交叠高亮')
  assert.ok(reportHtml.includes('消失的引文ZZZ'), '报告应列出待处理标注')
  // 文件名：审阅报告_<标题>_<YYYY-MM-DD>.html
  assert.match(
    captured[0]!.filename,
    new RegExp(`^审阅报告_报告测试文档_\\d{4}-\\d{2}-\\d{2}\\.html$`),
    `文件名应含标题与日期：${captured[0]!.filename}`,
  )
  // 不修改本地数据
  assert.strictEqual(
    localStorage.getItem('anchor-annotation-console:v1'),
    before,
    '生成报告不得修改本地数据',
  )

  window.HTMLElement.prototype.click = nativeClick
  rr.unmount()
  rc.remove()
  console.log('  ✓ 审阅报告：侧栏入口、HTML 下载、内容齐全、文件名规范且本地数据不变')
}

// 标注关系：建立有向关系（禁自关联/完全重复）→ 类型筛选与定位端 → 失效（待处理/删除）与恢复 → 导入导出
{
  const relText = '零一二三四五六七八九'
  const mk = (id: string, start: number, end: number, tags: string[] = []) => ({
    id,
    quote: relText.slice(start, end),
    start,
    end,
    note: '',
    tags,
    status: 'bound' as const,
    createdAt: 1,
    updatedAt: 1,
    contextBefore: '',
    contextAfter: '',
  })
  const relDoc = {
    title: '关系文档',
    text: relText,
    updatedAt: Date.now(),
    annotations: [mk('rel_a', 0, 2, ['论点']), mk('rel_b', 3, 5, ['论据']), mk('rel_c', 6, 8)],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(relDoc))
  const ec = document.createElement('div')
  ec.id = 'rootrel'
  document.body.appendChild(ec)
  const er = createRoot(ec)

  await new Promise<void>((resolve) => {
    er.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const section = () => ec.querySelector('.relations-section') as HTMLElement
  assert.ok(section(), '应渲染标注关系分区')
  assert.ok(ec.innerHTML.includes('标注关系'), '顶栏 / 侧栏应出现标注关系入口')

  const setNativeValue = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
    const proto =
      el instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
    el.dispatchEvent(new window.Event('change', { bubbles: true }))
  }
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 120))
  const saved = () => JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)

  // 1. 建立 rel_a → rel_b「支撑」
  const selects = () => [...section()!.querySelectorAll('.rel-select')] as HTMLSelectElement[]
  assert.strictEqual(selects().length, 2, '应有源 / 目标两个标注下拉')
  setNativeValue(selects()[0]!, 'rel_a')
  setNativeValue(selects()[1]!, 'rel_b')
  setNativeValue(section()!.querySelector('.rel-type-input') as HTMLInputElement, '支撑')
  await wait()
  const submitBtn = [...section()!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '建立关系',
  ) as HTMLButtonElement
  assert.ok(!submitBtn.disabled, '两端不同且类型非空时应可提交')
  submitBtn.click()
  await wait()
  let persisted = saved()
  assert.strictEqual(persisted.relations.length, 1, '关系应持久化')
  assert.deepStrictEqual(
    [persisted.relations[0].sourceId, persisted.relations[0].targetId, persisted.relations[0].type],
    ['rel_a', 'rel_b', '支撑'],
  )
  assert.ok(section()!.textContent!.includes('有效'), '应展示有效计数')

  // 2. 禁止自关联：源与目标同为 rel_a → 提交禁用 + 提示
  setNativeValue(selects()[0]!, 'rel_a')
  setNativeValue(selects()[1]!, 'rel_a')
  setNativeValue(section()!.querySelector('.rel-type-input') as HTMLInputElement, '自述')
  await wait()
  assert.ok(section()!.textContent!.includes('不能是同一条标注'), '应提示禁止自关联')
  assert.ok(
    ([...section()!.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === '建立关系',
    ) as HTMLButtonElement).disabled,
    '自关联时提交应禁用',
  )

  // 3. 禁止完全重复：rel_a → rel_b「支撑」已存在 → 禁用 + 提示；反向 + 同类型允许
  setNativeValue(selects()[1]!, 'rel_b')
  const typeInput = section()!.querySelector('.rel-type-input') as HTMLInputElement
  setNativeValue(typeInput, '支撑')
  await wait()
  assert.ok(section()!.textContent!.includes('已存在完全相同的关系'), '应提示完全重复')
  // 反向 rel_b → rel_a「支撑」是不同关系，应允许
  setNativeValue(selects()[0]!, 'rel_b')
  setNativeValue(selects()[1]!, 'rel_a')
  await wait()
  const submitBtn2 = [...section()!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '建立关系',
  ) as HTMLButtonElement
  assert.ok(!submitBtn2.disabled, '方向相反时不算重复，应允许建立')
  submitBtn2.click()
  await wait()
  assert.strictEqual(saved().relations.length, 2)

  // 再建一条 rel_a → rel_c「反驳」用于类型筛选
  setNativeValue(selects()[0]!, 'rel_a')
  setNativeValue(selects()[1]!, 'rel_c')
  setNativeValue(section()!.querySelector('.rel-type-input') as HTMLInputElement, '反驳')
  await wait()
  ;([...section()!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '建立关系',
  ) as HTMLButtonElement).click()
  await wait()
  assert.strictEqual(saved().relations.length, 3)

  // 4. 类型筛选：只看「反驳」→ 1 条有效关系卡片；切回全部 → 3 条
  const filterBtn = [...section()!.querySelectorAll('.rel-filter')].find((b) =>
    b.textContent?.trim().startsWith('反驳'),
  ) as HTMLButtonElement
  filterBtn.click()
  await wait()
  assert.strictEqual(section()!.querySelectorAll('.rel-item:not(.rel-item-invalid)').length, 1)
  ;([...section()!.querySelectorAll('.rel-filter')].find(
    (b) => b.textContent?.trim().startsWith('全部'),
  ) as HTMLButtonElement).click()
  await wait()
  assert.strictEqual(section()!.querySelectorAll('.rel-item').length, 3)

  // 5. 点击关系一端可定位（绑定 onFocus）：点击后原文容器出现高亮 id
  const firstEnd = section()!.querySelector('.rel-end') as HTMLButtonElement
  assert.ok(firstEnd, '应渲染可点击的关系端')
  firstEnd.click()
  await wait()
  // activeId 设置后 TextView 高亮该标注（侧栏端按钮带 active 样式）
  assert.ok(
    section()!.querySelector('.rel-end-active'),
    '点击关系端后该端应处于激活高亮状态',
  )

  // 6. 删除标注 rel_c：rel_a→rel_c「反驳」进入失效折叠区，页脚/顶栏出现失效计数
  const relCItem = [...ec.querySelectorAll('.ann-item')].find((el) =>
    el.textContent?.includes(relText.slice(6, 8)),
  ) as HTMLElement
  ;(globalThis as unknown as { confirm: () => boolean }).confirm = () => true
  window.confirm = () => true
  ;([...relCItem.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '删除',
  ) as HTMLButtonElement).click()
  await wait()
  persisted = saved()
  assert.strictEqual(persisted.relations.length, 3, '删除标注不自动删除关系记录')
  const fold = section()!.querySelector('.rel-invalid-fold') as HTMLElement
  assert.ok(fold, '失效关系应收入折叠区')
  assert.ok(fold.textContent!.includes('目标标注已删除'), '应标注失效原因')
  assert.ok(fold.textContent!.includes('反驳'), '折叠区应展示失效关系的类型')
  assert.ok(ec.innerHTML.includes('标注关系'), '顶栏入口仍在')
  // 侧栏汇总：有效 2 · 失效 1
  assert.ok(/有效\s*2\s*条/.test(section()!.textContent!))
  assert.ok(/失效\s*1\s*条/.test(section()!.textContent!))

  // 7. 待处理 → 失效：直接把 rel_b 改为 pending 重新挂载；重新绑定后恢复
  {
    const d = saved()
    const b = d.annotations.find((a: { id: string }) => a.id === 'rel_b')
    b.status = 'pending'
    b.pendingReason = '原文中已找不到该引文，需要手动重新选择'
    b.start = 0
    b.end = 0
    d.updatedAt = Date.now()
    localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(d))
  }
  er.unmount()
  const ec2 = document.createElement('div')
  ec2.id = 'rootrel2'
  document.body.appendChild(ec2)
  const er2 = createRoot(ec2)
  await new Promise<void>((resolve) => {
    er2.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })
  const section2 = () => ec2.querySelector('.relations-section') as HTMLElement
  // rel_a→rel_b 与 rel_b→rel_a 均因 rel_b pending 失效，加 rel_c 已删 → 有效 0 / 失效 3
  assert.ok(/有效\s*0\s*条/.test(section2()!.textContent!))
  assert.ok(/失效\s*3\s*条/.test(section2()!.textContent!))
  assert.ok(section2()!.textContent!.includes('源标注待处理'), '应区分源/目标待处理原因')
  assert.ok(section2()!.textContent!.includes('目标标注待处理'))

  // 重新绑定 rel_b → 两条 pending 失效关系恢复（删除造成的那条仍失效）。
  // jsdom 无法模拟原文拖选，这里直接以「rel_b 重新绑定成功」后的存档重新挂载，
  // 验证关系有效性完全由两端标注状态派生（重新绑定即恢复）这一核心语义。
  {
    const d = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
    const b = d.annotations.find((a: { id: string }) => a.id === 'rel_b')
    b.status = 'bound'
    b.start = 3
    b.end = 5
    b.pendingReason = undefined
    d.updatedAt = Date.now()
    localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(d))
  }
  er2.unmount()
  const ec3 = document.createElement('div')
  ec3.id = 'rootrel3'
  document.body.appendChild(ec3)
  const er3 = createRoot(ec3)
  await new Promise<void>((resolve) => {
    er3.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })
  const section3 = () => ec3.querySelector('.relations-section') as HTMLElement
  assert.ok(/有效\s*2\s*条/.test(section3()!.textContent!), '重新绑定后两条关系应恢复有效')
  assert.ok(/失效\s*1\s*条/.test(section3()!.textContent!), '删除造成的失效关系仍为失效')

  // 8. 导出结构含 relations；旧文件（无 relations）按空关系处理
  persisted = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.ok(Array.isArray(persisted.relations) && persisted.relations.length === 3, '本地存档应含关系')
  assert.deepStrictEqual(
    persisted.relations.map((r: { type: string }) => r.type).sort(),
    ['反驳', '支撑', '支撑'],
  )

  er3.unmount()
  ec.remove()
  ec2.remove()
  ec3.remove()
  console.log('  ✓ 标注关系：建立/禁自关联/禁重复、类型筛选、定位、待处理失效与恢复、删除失效、持久化')
}

// 关系基数上限审计：配置每源出边 / 每目标入边 → 违规实时列出（注明端）→ 不阻止建立 →
// 删除关系后重算 → 规则随本地与导出保存 → 旧数据缺字段兼容
{
  const capText = '甲乙丙丁戊己庚辛'
  const mk = (id: string, start: number) => ({
    id,
    quote: capText.slice(start, start + 1),
    start,
    end: start + 1,
    note: '',
    tags: [],
    status: 'bound' as const,
    createdAt: 1,
    updatedAt: 1,
    contextBefore: '',
    contextAfter: '',
  })
  // 预置两条「支撑」关系（在导入数据中直接给出，避免 UI 逐条建立）：
  // p1 → p2（早）、p1 → p3（晚）；配置 maxOut=1 后 p1→p3 源端超限
  const capDoc = {
    title: '基数文档',
    text: capText,
    updatedAt: Date.now(),
    annotations: [mk('cap_a', 0), mk('cap_b', 1), mk('cap_c', 2), mk('cap_d', 3)],
    relations: [
      { id: 'cap_r1', sourceId: 'cap_a', targetId: 'cap_b', type: '支撑', createdAt: 100 },
      { id: 'cap_r2', sourceId: 'cap_a', targetId: 'cap_c', type: '支撑', createdAt: 200 },
    ],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(capDoc))
  const cc = document.createElement('div')
  cc.id = 'rootcap'
  document.body.appendChild(cc)
  const cr = createRoot(cc)

  await new Promise<void>((resolve) => {
    cr.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const section = () => cc.querySelector('.relations-section') as HTMLElement
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 120))
  const saved = () => JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  const setNativeValue = (el: HTMLInputElement | HTMLSelectElement, v: string) => {
    const proto =
      el instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
    el.dispatchEvent(new window.Event('change', { bubbles: true }))
  }

  assert.ok(section()!.textContent!.includes('基数上限审计'), '应渲染基数审计折叠入口')
  // 未配置规则时无违规计数
  assert.ok(!section()!.textContent!.includes('基数违规'), '无规则时不应出现违规统计')

  // 展开基数规则折叠区
  ;(section()!.querySelector('.rel-cap-fold > summary') as HTMLElement).click()
  await wait()

  // 添加一行：类型「支撑」，每源最大出边 1，每目标最大入边留空
  ;([...section()!.querySelectorAll('.rel-cap-fold button')].find(
    (b) => b.textContent?.trim() === '添加一行',
  ) as HTMLButtonElement).click()
  await wait()
  setNativeValue(section()!.querySelector('.rel-cap-type') as HTMLInputElement, '支撑')
  const numInputs = () => [...section()!.querySelectorAll('.rel-cap-num')] as HTMLInputElement[]
  assert.strictEqual(numInputs().length, 2, '应有出边 / 入边两个名额输入')
  setNativeValue(numInputs()[0]!, '1') // 出边
  await wait()
  ;([...section()!.querySelectorAll('.rel-cap-fold button')].find(
    (b) => b.textContent?.trim() === '保存基数规则',
  ) as HTMLButtonElement).click()
  await wait()

  const persisted = saved()
  assert.strictEqual(persisted.relationCardinalityRules.length, 1, '基数规则应持久化')
  assert.deepStrictEqual(
    [
      persisted.relationCardinalityRules[0].type,
      persisted.relationCardinalityRules[0].maxOut,
      persisted.relationCardinalityRules[0].maxIn,
    ],
    ['支撑', 1, null],
  )

  // 违规列表出现：cap_r2（p1→p3，创建更晚）源端超限；cap_r1 不违规
  const overList = section()!.querySelector('.rel-over-list') as HTMLElement
  assert.ok(overList, '应列出基数违规区')
  assert.ok(overList.textContent!.includes('源端超限'), '应注明源端超限')
  assert.ok(overList.textContent!.includes('最多 1 条出边（实际 2 条）'), '应列名额与实际数')
  assert.ok(!overList.textContent!.includes('cap_r1'), '违规区只列超限关系（不显示 ID，但可校验卡片数）')
  assert.strictEqual(overList.querySelectorAll('.rel-item').length, 1, '仅 1 条出边超限')
  // 有效列表里的违规卡片带超限样式
  assert.ok(
    section()!.querySelectorAll('.rel-item-over').length >= 1,
    '有效关系卡片应标红提示超限',
  )
  // 顶栏出现计数（失效 0 + 违规 1 = 1）
  assert.ok(cc.innerHTML.includes('基数违规'), '汇总行应含基数违规计数')

  // 点击违规关系的源端可定位原文（active 高亮）
  ;(overList.querySelector('.rel-end') as HTMLButtonElement).click()
  await wait()
  assert.ok(section()!.querySelector('.rel-end-active'), '点击违规关系端点应可定位')

  // 审计不阻止建立关系：再建一条 cap_b → cap_d「支撑」（cap_b 的第一条出边，不违规）
  const selects = () => [...section()!.querySelectorAll('.rel-select')] as HTMLSelectElement[]
  setNativeValue(selects()[0]!, 'cap_b')
  setNativeValue(selects()[1]!, 'cap_d')
  setNativeValue(section()!.querySelector('.rel-type-input') as HTMLInputElement, '支撑')
  await wait()
  const createBtn = [...section()!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '建立关系',
  ) as HTMLButtonElement
  assert.ok(!createBtn.disabled, '基数审计不应阻止建立关系')
  createBtn.click()
  await wait()
  assert.strictEqual(saved().relations.length, 3, '超限只提示，不阻止建立')
  assert.strictEqual(section()!.querySelectorAll('.rel-over-list .rel-item').length, 1, '新关系不超限')

  // 删除超限关系 cap_r2 → 违规实时清空
  const overCard = section()!.querySelector('.rel-over-list .rel-item') as HTMLElement
  ;(globalThis as unknown as { confirm: () => boolean }).confirm = () => true
  window.confirm = () => true
  ;([...overCard.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === '删除关系',
  ) as HTMLButtonElement).click()
  await wait()
  assert.ok(!section()!.querySelector('.rel-over-list'), '删除后审计实时重算，违规清空')

  // 追加每目标入边 1 的限制并重建一条使 cap_b 入边超限：直接造数据后重挂载验证实时派生
  {
    const d = saved()
    d.relations.push(
      { id: 'cap_r3', sourceId: 'cap_c', targetId: 'cap_b', type: '支撑', createdAt: 300 },
    )
    d.updatedAt = Date.now()
    localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(d))
  }
  cr.unmount()
  const cc2 = document.createElement('div')
  cc2.id = 'rootcap2'
  document.body.appendChild(cc2)
  const cr2 = createRoot(cc2)
  await new Promise<void>((resolve) => {
    cr2.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })
  const section2 = () => cc2.querySelector('.relations-section') as HTMLElement
  // 此时规则只有 maxOut=1：各源出边均不超过 1；入边（cap_b 有 2 条）尚未配置名额 → 0 违规
  assert.ok(!section2()!.querySelector('.rel-over-list'), '未配置入边名额时入边不审计')

  // 打开编辑器补 maxIn=1 保存
  ;(section2()!.querySelector('.rel-cap-fold > summary') as HTMLElement).click()
  await wait()
  const numInputs2 = () => [...section2()!.querySelectorAll('.rel-cap-num')] as HTMLInputElement[]
  setNativeValue(numInputs2()[1]!, '1')
  await wait()
  ;([...section2()!.querySelectorAll('.rel-cap-fold button')].find(
    (b) => b.textContent?.trim() === '保存基数规则',
  ) as HTMLButtonElement).click()
  await wait()
  const over2 = section2()!.querySelector('.rel-over-list') as HTMLElement
  assert.ok(over2, 'cap_b 有两条「支撑」入边（cap_r1 早、cap_r3 晚）→ 晚的目标端超限')
  assert.ok(over2.textContent!.includes('目标端超限'))
  assert.strictEqual(over2.querySelectorAll('.rel-item').length, 1)
  assert.ok(over2.textContent!.includes('每条目标标注最多 1 条入边（实际 2 条）'))
  // 更新后的规则持久化
  const persisted2 = saved()
  assert.deepStrictEqual(
    [persisted2.relationCardinalityRules[0].maxOut, persisted2.relationCardinalityRules[0].maxIn],
    [1, 1],
  )
  // 导出（localStorage 即导出数据来源）含基数规则字段
  assert.ok(
    Array.isArray(persisted2.relationCardinalityRules) &&
      persisted2.relationCardinalityRules.length === 1,
    '导出数据应含基数上限规则',
  )

  cr2.unmount()
  cc.remove()
  cc2.remove()
  console.log('  ✓ 关系基数上限审计：规则配置持久化、源/目标超限实时列出且不阻止建立、删除与恢复重算')
}

// 同引文漏标审阅：选模板 → 枚举全部出现位置（待处理不算已标注）→ 勾选批量补建 →
// 复制模板标签与备注、按位置重截上下文 → 实时重算与持久化
{
  const mqText = '甲乙丙甲乙丁甲乙' // 「甲乙」出现在 0、3、6
  const mqDoc = {
    title: '漏标文档',
    text: mqText,
    updatedAt: Date.now(),
    annotations: [
      {
        id: 'mq_tpl',
        quote: '甲乙',
        start: 0,
        end: 2,
        note: '模板备注',
        tags: ['重点'],
        status: 'bound',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: '',
        contextAfter: '',
      },
      {
        // 与第二处出现位置起止相同的待处理标注：不算已标注
        id: 'mq_p',
        quote: '甲乙',
        start: 3,
        end: 5,
        note: '',
        tags: [],
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: '',
        contextAfter: '',
        pendingReason: '多处候选的前后文评分相同，为避免误绑需人工确认',
      },
    ],
  }
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(mqDoc))
  const mc = document.createElement('div')
  mc.id = 'rootmq'
  document.body.appendChild(mc)
  const mr = createRoot(mc)

  await new Promise<void>((resolve) => {
    mr.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })

  const section = () => mc.querySelector('.mq-section') as HTMLElement
  assert.ok(section(), '应渲染同引文漏标审阅分区')
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 150))
  const saved = () => JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)

  // 选择模板标注
  const select = section()!.querySelector('.mq-select') as HTMLSelectElement
  assert.ok(select, '应渲染模板下拉框')
  assert.strictEqual(select.querySelectorAll('option').length, 2, '待处理标注不应成为模板选项')
  select.value = 'mq_tpl'
  select.dispatchEvent(new window.Event('change', { bubbles: true }))
  await wait()

  // 汇总：共 3 处 · 已标注 1 · 漏标 2（待处理同区间不算已标注）
  const summary = section()!.querySelector('.mq-summary')!.textContent!
  assert.ok(/共出现\s*3\s*处/.test(summary), `应枚举 3 处出现：${summary}`)
  assert.ok(/已标注\s*1\s*处/.test(summary), '仅起止完全相同的已绑定标注算已标注')
  assert.ok(/漏标\s*2\s*处/.test(summary), '待处理同区间不算已标注')
  assert.ok(section()!.textContent!.includes('模板备注'), '应展示将复制的模板备注')
  assert.ok(section()!.textContent!.includes('#重点'), '应展示将复制的模板标签')

  // 漏标列表：2 条，含前后文与位置；已标注位置折叠区 1 条
  const missingItems = () => section()!.querySelectorAll('.mq-item:not(.mq-item-covered)')
  assert.strictEqual(missingItems().length, 2, '应列出 2 处漏标位置')
  assert.ok(missingItems()[0]!.textContent!.includes('[3,5)'), '漏标项应展示区间')
  assert.ok(missingItems()[0]!.textContent!.includes('第 2 处'), '漏标项应展示出现序号')
  const fold = section()!.querySelector('.mq-covered-fold') as HTMLElement
  assert.ok(fold && fold.textContent!.includes('已标注位置（1）'), '已标注位置应收入折叠区')

  // 顶栏与页脚出现漏标计数
  assert.ok(mc.innerHTML.includes('漏标审阅'), '顶栏应出现漏标审阅入口')
  assert.ok(mc.textContent!.includes('2 处同引文漏标'), '页脚应显示漏标数')

  // 点击第一处漏标 → 原文出现 qs-range 高亮
  ;(missingItems()[0]!.querySelector('.mq-item-main') as HTMLButtonElement).click()
  await wait()
  const qsMark = mc.querySelector('.qs-range') as HTMLElement
  assert.ok(qsMark, '点击漏标位置后原文应出现高亮标记')
  assert.strictEqual(qsMark.dataset.start, '3')
  assert.strictEqual(qsMark.dataset.end, '5')

  // 全选 → 补建标注（2）
  const clickButton = (text: string, root: ParentNode = section()!) => {
    const btn = [...root.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text || b.textContent?.trim().startsWith(text),
    ) as HTMLButtonElement | undefined
    assert.ok(btn, `应存在按钮「${text}」`)
    btn!.click()
    return btn!
  }
  clickButton('全选')
  await wait()
  assert.ok(section()!.textContent!.includes('已选 2'), '全选后应显示已选 2 处')
  clickButton('补建标注')
  await wait()

  // 落地：新增 2 条已绑定标注，复制模板标签与备注，按各位置重截上下文
  const persisted = saved()
  assert.strictEqual(persisted.annotations.length, 4, '应新增 2 条标注')
  const created = persisted.annotations.filter((a: { id: string }) => a.id.startsWith('a_'))
  assert.strictEqual(created.length, 2)
  const byStart = (s: number) =>
    persisted.annotations.find(
      (a: { start: number; status: string }) => a.start === s && a.status === 'bound',
    )
  const c3 = byStart(3)
  const c6 = byStart(6)
  assert.ok(c3 && c6, '两个漏标位置都应补建已绑定标注')
  for (const c of [c3, c6]) {
    assert.strictEqual(c.quote, '甲乙')
    assert.deepStrictEqual(c.tags, ['重点'])
    assert.strictEqual(c.note, '模板备注')
  }
  assert.strictEqual(c3.contextBefore, mqText.slice(0, 3), '应按新位置重截上文')
  assert.strictEqual(c3.contextAfter, mqText.slice(5), '应按新位置重截下文')
  assert.strictEqual(c6.contextBefore, mqText.slice(0, 6))
  // 待处理标注不受补建影响
  const stillPending = persisted.annotations.find((a: { id: string }) => a.id === 'mq_p')
  assert.strictEqual(stillPending.status, 'pending')

  // 实时重算：漏标清零，出现 ✓ 提示与结果消息
  await wait()
  assert.ok(section()!.textContent!.includes('已补建 2 条标注'), '应给出补建结果提示')
  assert.ok(section()!.textContent!.includes('没有漏标'), '补建后应显示无漏标')
  assert.ok(!mc.textContent!.includes('处同引文漏标'), '页脚漏标计数应消失')

  // 刷新（重新挂载）后数据保持一致；补建标注随本地保存存在
  mr.unmount()
  const mc2 = document.createElement('div')
  mc2.id = 'rootmq2'
  document.body.appendChild(mc2)
  const mr2 = createRoot(mc2)
  await new Promise<void>((resolve) => {
    mr2.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 400)
  })
  const reparsed = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.strictEqual(reparsed.annotations.length, 4, '刷新后补建标注仍在')
  assert.strictEqual(
    reparsed.annotations.filter(
      (a: { quote: string; status: string }) => a.quote === '甲乙' && a.status === 'bound',
    ).length,
    3,
    '三处出现位置均已有已绑定标注',
  )
  // 导出数据（localStorage 即导出数据来源）包含补建标注的标签与上下文
  const exportedC3 = reparsed.annotations.find(
    (a: { start: number; status: string }) => a.start === 3 && a.status === 'bound',
  )
  assert.deepStrictEqual(exportedC3.tags, ['重点'])
  assert.strictEqual(typeof exportedC3.contextBefore, 'string')

  mr2.unmount()
  mc.remove()
  mc2.remove()
  console.log('  ✓ 同引文漏标审阅：模板枚举、待处理不算已标注、批量补建复制标签备注、实时重算与持久化')
}

// 旧版数据（无 conflictRules / ignoredConflicts 字段）应无损加载
const legacy = {
  title: '旧文档',
  text: '一二三四五六',
  updatedAt: Date.now(),
  annotations: [],
}
localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(legacy))
root3.unmount()
const container4 = document.createElement('div')
container4.id = 'root4'
document.body.appendChild(container4)
const root4 = createRoot(container4)

await new Promise<void>((resolve) => {
  root4.render(
    React.createElement(React.StrictMode, null, React.createElement(App)),
  )
  setTimeout(resolve, 400)
})

const html4 = container4.innerHTML
assert.ok(html4.includes('旧文档'), '旧版数据应正常加载标题')
assert.ok(html4.includes('冲突审阅'), '旧版数据应补出冲突审阅分区')
assert.ok(html4.includes('尚未配置互斥标签对'), '旧版数据应显示未配置规则提示')
// 保存回 localStorage 时应自动补齐新字段且不破坏原有数据
const reparsed = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
assert.ok(Array.isArray(reparsed.conflictRules) && reparsed.conflictRules.length === 0)
assert.ok(Array.isArray(reparsed.ignoredConflicts) && reparsed.ignoredConflicts.length === 0)
assert.ok(Array.isArray(reparsed.coverageTags) && reparsed.coverageTags.length === 0)
assert.strictEqual(reparsed.baseline, null)
assert.ok(Array.isArray(reparsed.reviewedDiffs) && reparsed.reviewedDiffs.length === 0)
assert.strictEqual(reparsed.sampleConfig, null)
assert.ok(Array.isArray(reparsed.sampleReviews) && reparsed.sampleReviews.length === 0)
assert.ok(Array.isArray(reparsed.relations) && reparsed.relations.length === 0)
assert.ok(
  Array.isArray(reparsed.relationCardinalityRules) &&
    reparsed.relationCardinalityRules.length === 0,
)
assert.strictEqual(reparsed.text, '一二三四五六')
console.log('  ✓ 旧数据无损兼容并自动补齐冲突字段、标注关系与基数规则空数组')

root4.unmount()
container4.remove()
container3.remove()

// 新录入原文（无任何已绑定标注）→ 阅读视图完整显示且可在普通文本上拖选创建首条标注；
// 仅剩待处理标注时正文同样不消失，且可拖选发起重新绑定
{
  // TextView 的 mouseup 处理器读取选区几何；jsdom 的 Range 未实现 getBoundingClientRect
  if (typeof window.Range.prototype.getBoundingClientRect !== 'function') {
    window.Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return {
        top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, width: 0, height: 0, toJSON() {},
      } as DOMRect
    }
  }

  const { setSelectionRange } = await import('../src/lib/dom')
  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
    const proto =
      el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const clickButton = (rootEl: ParentNode, text: string) => {
    const btn = [...rootEl.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined
    assert.ok(btn, `应存在按钮「${text}」`)
    btn!.click()
    return btn!
  }
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 150))

  // 清掉旧文档：空存储挂载 → 编辑模式
  localStorage.removeItem('anchor-annotation-console:v1')
  const cf = document.createElement('div')
  cf.id = 'rootfresh'
  document.body.appendChild(cf)
  const fr = createRoot(cf)
  await new Promise<void>((resolve) => {
    fr.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 300)
  })

  const freshText = '这是全新录入的原文，全部是普通文字，还没有任何已绑定标注。'
  assert.ok(cf.querySelector('.editor-textarea'), '空文档应直接进入编辑模式')
  setNativeValue(cf.querySelector('.editor-textarea') as HTMLTextAreaElement, freshText)
  clickButton(cf, '完成编辑')
  await wait()

  const view = cf.querySelector('.text-view') as HTMLElement | null
  assert.ok(view, '完成编辑后应渲染阅读视图（而非空白）')
  assert.strictEqual(view!.textContent, freshText, '无标注时阅读视图应完整显示原文')
  assert.strictEqual(view!.querySelectorAll('mark.hl').length, 0, '不应有任何高亮段')

  // 在普通文本（无高亮）上拖选 → 弹出首条标注创建表单
  assert.ok(setSelectionRange(view!, 5, 11), '应能在普通文本上设置选区')
  view!.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
  await wait()
  assert.ok(cf.querySelector('.annotation-form'), '普通文本拖选后应弹出标注创建表单')
  console.log('  ✓ 新录入原文：阅读视图完整显示，普通文本可拖选创建首条标注')

  // 提交首条标注后它出现在原文上
  setNativeValue(cf.querySelector('.annotation-form .form-note') as HTMLTextAreaElement, '首条备注')
  cf.querySelector('.annotation-form')!.dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }),
  )
  await wait()
  assert.ok(!cf.querySelector('.annotation-form'), '提交后表单关闭')
  assert.ok(cf.querySelector('.text-view mark.hl'), '首条标注应渲染为高亮')
  const stored1 = JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)
  assert.strictEqual(stored1.annotations.length, 1)
  assert.strictEqual(stored1.annotations[0].status, 'bound')

  // 仅剩待处理标注：挂载一份只有 pending 标注的文档，正文仍完整、可发起重绑
  const onlyPending = {
    title: '仅待处理文档',
    text: freshText,
    updatedAt: Date.now(),
    annotations: [
      {
        id: 'pend_only',
        quote: '消失的引文ZZZ',
        start: 0,
        end: 0,
        note: '',
        tags: [],
        status: 'pending',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: '',
        contextAfter: '',
        pendingReason: '原文中已找不到该引文，需要手动重新选择',
      },
    ],
  }
  fr.unmount()
  cf.remove()
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(onlyPending))
  const cp2 = document.createElement('div')
  cp2.id = 'rootpendonly2'
  document.body.appendChild(cp2)
  const pr2 = createRoot(cp2)
  await new Promise<void>((resolve) => {
    pr2.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 300)
  })

  const viewP = cp2.querySelector('.text-view') as HTMLElement | null
  assert.ok(viewP, '仅剩待处理标注时阅读视图不应消失')
  assert.strictEqual(viewP!.textContent, freshText, '仅剩待处理标注时正文仍应完整显示')
  assert.strictEqual(viewP!.querySelectorAll('mark.hl').length, 0, '待处理标注不应产生高亮')
  console.log('  ✓ 仅剩待处理标注：阅读视图仍完整显示原文')

  // 点击「重新选择片段」进入重绑，再在普通文本上拖选 → 重绑确认弹层
  const rebindBtn = [...cp2.querySelectorAll('button')].find(
    (b) => b.textContent?.includes('重新选择片段'),
  ) as HTMLButtonElement | undefined
  assert.ok(rebindBtn, '待处理标注应提供重新选择片段入口')
  rebindBtn!.click()
  await wait()
  assert.ok(cp2.querySelector('.text-view.rebinding'), '原文应进入重绑十字光标态')
  assert.ok(setSelectionRange(viewP!, 8, 14), '重绑时应能在普通文本上设置选区')
  viewP!.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
  await wait()
  assert.ok(cp2.textContent?.includes('确认绑定'), '重绑拖选后应出现确认绑定弹层')
  console.log('  ✓ 仅剩待处理标注时可在普通文本上拖选重新绑定')

  pr2.unmount()
  cp2.remove()
}

// 锚点误绑回归（编辑前后原文比对）：
// 同一引文在相距不足 200 字处出现两次；编辑删除「已标注的那处」后，
// 不得静默绑到剩余副本——标注应进入待处理并说明原因，手动重绑仍可恢复。
{
  const { setSelectionRange } = await import('../src/lib/dom')
  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
    const proto =
      el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const clickButton = (rootEl: ParentNode, text: string) => {
    const btn = [...rootEl.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined
    assert.ok(btn, `应存在按钮「${text}」`)
    btn!.click()
    return btn!
  }
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 150))
  const saved = () => JSON.parse(localStorage.getItem('anchor-annotation-console:v1')!)

  const dupText = '开头铺垫文字：【相同引文】随后是十几字的间隔文字，再次出现【相同引文】全文结束。'
  const firstPos = dupText.indexOf('【相同引文】')
  const dupDoc = {
    title: '重复引文文档',
    text: dupText,
    updatedAt: Date.now(),
    annotations: [
      {
        id: 'dup_a',
        quote: '【相同引文】',
        start: firstPos,
        end: firstPos + 6,
        note: '标注第一处',
        tags: ['重点'],
        status: 'bound',
        createdAt: 1,
        updatedAt: 1,
        contextBefore: dupText.slice(Math.max(0, firstPos - 50), firstPos),
        contextAfter: dupText.slice(firstPos + 6, firstPos + 6 + 50),
      },
    ],
  }
  // 前置条件：两处相距不足 200 字
  assert.ok(dupText.lastIndexOf('【相同引文】') - firstPos < 200)
  localStorage.setItem('anchor-annotation-console:v1', JSON.stringify(dupDoc))
  const cd = document.createElement('div')
  cd.id = 'rootdup'
  document.body.appendChild(cd)
  const dr = createRoot(cd)
  await new Promise<void>((resolve) => {
    dr.render(React.createElement(React.StrictMode, null, React.createElement(App)))
    setTimeout(resolve, 300)
  })

  // 场景 A：只在标注前方插入文字 → 自动跟随，仍绑在「带随后间隔文字」的原位（非第二处副本）
  clickButton(cd, '粘贴 / 编辑原文')
  await wait()
  const editor = cd.querySelector('.editor-textarea') as HTMLTextAreaElement
  setNativeValue(editor, '>>>插入前缀<<<' + dupText)
  clickButton(cd, '完成编辑')
  await wait()
  let data = saved()
  assert.strictEqual(data.annotations[0].status, 'bound', '前方插入后应自动跟随')
  assert.strictEqual(data.annotations[0].lastRelocation.reason, 'tracked')
  assert.strictEqual(data.annotations[0].start, firstPos + '>>>插入前缀<<<'.length)
  assert.strictEqual(
    data.text.slice(data.annotations[0].end, data.annotations[0].end + 3),
    '随后是',
    '跟随的必须是原第一处，而非后面的同文副本',
  )

  // 场景 B（核心回归）：删除已标注的第一处（连同其后几个字），第二处副本仍在
  clickButton(cd, '粘贴 / 编辑原文')
  await wait()
  const curText: string = saved().text
  const p = curText.indexOf('【相同引文】')
  const deleted = curText.slice(0, p) + curText.slice(p + '【相同引文】随后是'.length)
  assert.ok(deleted.includes('【相同引文】'), '前置条件：剩余副本仍在')
  assert.strictEqual(deleted.indexOf('【相同引文】'), deleted.lastIndexOf('【相同引文】'),
    '前置条件：只剩一处同文副本')
  setNativeValue(cd.querySelector('.editor-textarea') as HTMLTextAreaElement, deleted)
  clickButton(cd, '完成编辑')
  await wait()

  data = saved()
  assert.strictEqual(data.annotations[0].status, 'pending',
    '删掉已标注处后只剩同文副本，必须进入待处理而非静默误绑')
  assert.ok(
    data.annotations[0].pendingReason?.includes('无法确认'),
    `待处理原因应说明身份无法确认，实际：${data.annotations[0].pendingReason}`,
  )
  assert.ok(cd.textContent?.includes('待处理'), '界面应展示待处理状态')
  // 全文仅此一条标注且已 pending：正文不应出现任何标注高亮（不得落到剩余副本上）
  const viewAfter = cd.querySelector('.text-view') as HTMLElement
  assert.strictEqual(
    viewAfter.querySelectorAll('mark.hl').length,
    0,
    '待处理标注不应在剩余副本处渲染高亮',
  )

  // 场景 C：手动重绑可恢复 —— 拖选剩余副本并确认
  const rebind = [...cd.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('重新选择片段'),
  ) as HTMLButtonElement
  assert.ok(rebind, '待处理标注应提供手动重绑入口')
  rebind.click()
  await wait()
  const remainPos = deleted.indexOf('【相同引文】')
  const viewForRebind = cd.querySelector('.text-view') as HTMLElement
  assert.ok(setSelectionRange(viewForRebind!, remainPos, remainPos + 6))
  viewForRebind!.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
  await wait()
  assert.ok(cd.textContent?.includes('确认绑定'), '拖选后应出现确认绑定弹层')
  clickButton(cd, '确认绑定')
  await wait()
  data = saved()
  assert.strictEqual(data.annotations[0].status, 'bound', '手动重绑后恢复已绑定')
  assert.strictEqual(data.annotations[0].start, remainPos)
  assert.strictEqual(data.annotations[0].end, remainPos + 6)
  assert.strictEqual(data.annotations[0].pendingReason, undefined)
  console.log('  ✓ 锚点误绑回归：删除已标注处后不绑同文副本而进入待处理，前方插入自动跟随，手动重绑可恢复')

  dr.unmount()
  cd.remove()
}

console.log('\n全部渲染冒烟测试通过')
