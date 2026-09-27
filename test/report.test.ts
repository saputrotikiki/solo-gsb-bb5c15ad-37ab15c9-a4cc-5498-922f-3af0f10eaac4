import assert from 'node:assert'
import {
  buildReviewReport,
  formatLocalDateTime,
  reportFilename,
  safeFilePart,
  type ReportInput,
} from '../src/lib/report'
import type { Annotation } from '../src/types'

const now = new Date('2026-09-18T03:04:05.000Z')

function mkAnn(partial: Partial<Annotation> & { id: string }): Annotation {
  return {
    quote: '',
    start: 0,
    end: 0,
    note: '',
    tags: [],
    status: 'bound',
    createdAt: 1,
    updatedAt: 1,
    contextBefore: '',
    contextAfter: '',
    ...partial,
  }
}

const text = '甲乙丙丁戊己庚辛壬癸'

function baseInput(): ReportInput {
  return {
    title: '审阅<测试>文档',
    text,
    annotations: [
      mkAnn({
        id: 'b1',
        quote: text.slice(0, 3),
        start: 0,
        end: 3,
        tags: ['正面', '重点'],
        note: '第一条<b>备注',
      }),
      mkAnn({
        id: 'b2',
        quote: text.slice(2, 5),
        start: 2,
        end: 5,
        tags: ['反面'],
        note: '',
      }),
      mkAnn({
        id: 'p1',
        quote: '已经消失的引文XYZ',
        start: 0,
        end: 0,
        tags: ['待处理标签'],
        note: '待处理备注',
        status: 'pending',
        pendingReason: '原文中已找不到该引文，需要手动重新选择',
      }),
    ],
    conflictRules: [{ id: 'r1', tagA: '正面', tagB: '反面', createdAt: 1 }],
    ignoredConflicts: [],
    coverageTags: ['正面'],
    relations: [
      { id: 'rel1', sourceId: 'b1', targetId: 'b2', type: '支撑', createdAt: 1 },
      // 引用待处理标注：失效关系
      { id: 'rel2', sourceId: 'b1', targetId: 'p1', type: '引用', createdAt: 2 },
      // 引用已删除标注：失效关系（两端都不在 annotations 中）
      { id: 'rel3', sourceId: 'gone1', targetId: 'gone2', type: '反驳', createdAt: 3 },
    ],
  }
}

// 1. 汇总统计：总数 / 待处理 / 冲突 / 覆盖问题
{
  const input = baseInput()
  const report = buildReviewReport(input, now)
  // b1=[0,3) 与 b2=[2,5) 交叠且标签命中 正面⇄反面 → 1 条冲突
  assert.strictEqual(report.stats.total, 3)
  assert.strictEqual(report.stats.pending, 1)
  assert.strictEqual(report.stats.conflicts, 1)
  // 只审计「正面」：b1 覆盖 [0,3)，[3,10) 为缺口（合并一条）
  assert.strictEqual(report.stats.coverageIssues, 1)
  // rel1 两端均已绑定 → 1 条有效；rel2 一端 pending、rel3 两端已删除 → 2 条失效
  assert.strictEqual(report.stats.relationsActive, 1)
  assert.strictEqual(report.stats.relationsInvalid, 2)
  console.log('  ✓ 汇总统计：总数/待处理/冲突/覆盖问题/有效失效关系')
}

// 2. 纯函数：不修改输入；同输入同输出
{
  const input = baseInput()
  const snapshot = JSON.stringify(input)
  const r1 = buildReviewReport(input, now)
  const r2 = buildReviewReport(input, now)
  assert.strictEqual(r1.html, r2.html, '相同输入必须产出相同 HTML')
  assert.strictEqual(JSON.stringify(input), snapshot, '生成报告不得修改输入数据')
  console.log('  ✓ 纯函数：确定性输出且不修改输入')
}

// 3. HTML 自包含且正确转义；含全部关键内容
{
  const report = buildReviewReport(baseInput(), now)
  const html = report.html
  assert.ok(html.startsWith('<!doctype html>'), '应以 doctype 开头')
  assert.ok(!/<script|src=|href="https?:/i.test(html), '不应引用任何外部资源')
  assert.ok(html.includes('<style>'), '应内嵌样式')
  assert.ok(html.includes('审阅&lt;测试&gt;文档'), '标题中的 HTML 特殊字符应转义')
  assert.ok(html.includes('第一条&lt;b&gt;备注'), '备注中的 HTML 特殊字符应转义')
  // 原文渲染
  assert.ok(html.includes('rep-text'), '应有原文区')
  assert.ok(html.includes('rep-hl'), '已绑定区间应渲染为高亮 mark')
  assert.ok(html.includes('rep-hl-conflict'), '冲突交叠段应有冲突描边类')
  assert.ok(html.includes('rep-cov-gap'), '覆盖缺口段应有缺口底色类')
  // 上标芯片链接到明细
  assert.ok(html.includes('href="#ann-1"'), '段首序号应链接到标注明细')
  assert.ok(html.includes('id="ann-1"'), '标注明细应有锚点')
  // 明细：引文、位置、标签、备注
  assert.ok(html.includes('#正面'), '应渲染标签')
  assert.ok(html.includes('[0, 3)'), '应渲染标注位置')
  // 待处理
  assert.ok(html.includes('待处理标注（1）'), '应有待处理分区与计数')
  assert.ok(html.includes('已经消失的引文XYZ'), '应列出待处理引文')
  assert.ok(html.includes('待处理备注'), '应列出待处理备注')
  assert.ok(html.includes('待处理标签'), '应列出待处理标签')
  assert.ok(html.includes('需要手动重新选择'), '应列出待处理原因')
  // 冲突双方
  assert.ok(html.includes('正面 ⇄ 反面'), '应列出命中规则')
  assert.ok(html.includes('交叠原文'), '应列出交叠原文')
  const sideCount = (html.match(/class="rep-conflict-side"/g) ?? []).length
  assert.strictEqual(sideCount, 2, '冲突应列出双方')
  assert.ok(html.includes('href="#ann-1"'), '冲突一方应可跳到标注明细')
  // 覆盖问题
  assert.ok(html.includes('覆盖问题（1）'), '应有覆盖问题分区与计数')
  assert.ok(html.includes('rep-cov-flag-gap'), '应列出缺口项')
  // 标注关系：有效 1 条（b1 → b2，含类型与两端引文，端序号可跳转明细）
  assert.ok(html.includes('标注关系 · 有效（1）'), '应有有效关系分区与计数')
  assert.ok(html.includes('id="relation-active-1"'), '有效关系应有锚点')
  assert.ok(html.includes('支撑'), '应列出关系类型')
  assert.ok(html.includes('rep-rel-arrow'), '应渲染有向箭头')
  const relSides = (html.match(/class="rep-rel-side"/g) ?? []).length
  assert.strictEqual(relSides, 6, '3 条关系 × 2 端 = 6 个关系端')
  // 失效关系 2 条：一端 pending（待处理标签）、两端已删除（占位说明）
  assert.ok(html.includes('失效关系（2）'), '应有失效关系分区与计数')
  assert.ok(html.includes('目标标注待处理'), '应列出 pending 失效原因')
  assert.ok(html.includes('源与目标标注均已删除'), '应列出删除占位')
  assert.ok(html.includes('有效关系'), '汇总中应含有效关系统计')
  assert.ok(html.includes('失效关系'), '汇总中应含失效关系统计')
  console.log('  ✓ HTML 自包含、转义正确，含高亮/引文/标签/备注/待处理/冲突双方/覆盖问题/关系')
}

// 4. 已忽略冲突不计入统计，但缺口/重叠仍按审计标签计算
{
  const input = baseInput()
  input.ignoredConflicts = [
    { annotationIds: ['b1', 'b2'], ruleIds: ['r1'], createdAt: 1 },
  ]
  input.coverageTags = ['正面', '反面']
  const report = buildReviewReport(input, now)
  assert.strictEqual(report.stats.conflicts, 0, '已忽略冲突不计入冲突数')
  // 去掉内嵌样式表（其中包含同名选择器），只检查正文标记
  const bodyHtml = report.html.replace(/<style>[\s\S]*?<\/style>/, '')
  assert.ok(!bodyHtml.includes('rep-hl-conflict'), '已忽略冲突的交叠不应有冲突描边')
  assert.ok(report.html.includes('1 条已忽略'), '应附注已忽略冲突数量')
  // b1=[0,3) 与 b2=[2,5) 都命中审计标签：[2,3) 为重叠，[5,10) 为缺口
  assert.strictEqual(report.stats.coverageIssues, 2)
  assert.ok(report.html.includes('rep-cov-flag-overlap'), '应列出重叠项')
  assert.ok(report.html.includes('2 条标注叠加') === false, '报告重叠卡片按自有文案渲染')
  console.log('  ✓ 已忽略冲突排除、覆盖缺口与重叠分别统计')
}

// 5. 边界：空原文与无标注
{
  const report = buildReviewReport(
    {
      title: '',
      text: '',
      annotations: [],
      conflictRules: [],
      ignoredConflicts: [],
      coverageTags: [],
    },
    now,
  )
  assert.deepStrictEqual(report.stats, {
    total: 0,
    pending: 0,
    conflicts: 0,
    coverageIssues: 0,
    relationsActive: 0,
    relationsInvalid: 0,
    relationOverLimit: 0,
  })
  assert.ok(report.html.includes('原文为空'), '空原文应有提示')
  assert.ok(report.html.includes('没有已绑定标注'))
  assert.ok(report.html.includes('没有待处理标注'))
  assert.ok(report.html.includes('没有未忽略冲突'))
  assert.ok(report.html.includes('未配置覆盖审计标签'))
  assert.ok(report.html.includes('没有有效关系'))
  assert.ok(report.html.includes('没有失效关系'))
  assert.ok(report.html.includes('没有超出基数上限的有效关系'))
  console.log('  ✓ 空文档边界')
}

// 6. 文件名含文档标题与日期；非法字符替换
{
  const name = reportFilename('a/b:c*d?e', now)
  assert.strictEqual(name, '审阅报告_a_b_c_d_e_2026-09-18.html')
  assert.strictEqual(safeFilePart('   '), '_', '纯空白与共享导出口径一致，替换为下划线')
  assert.strictEqual(reportFilename('   ', now), '审阅报告_未命名文档_2026-09-18.html', '报告文件名纯空白标题回退为默认名')
  assert.strictEqual(safeFilePart(''), '未命名文档', '空标题回退为默认名')
  const name2 = reportFilename('正常标题', now)
  assert.ok(name2.endsWith('_2026-09-18.html'))
  // 时间格式化不抛错且为本地时间字符串
  assert.match(formatLocalDateTime(now), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  console.log('  ✓ 文件名包含文档标题与日期，非法字符被替换')
}

// 7. 多标注叠加段携带全部序号，明细按原文位置编号
{
  const input = baseInput()
  // 追加一条与前两条都交叠的标注，叠加段应包含 3 个序号
  input.annotations.push(
    mkAnn({ id: 'b3', quote: text.slice(1, 4), start: 1, end: 4, tags: ['其他'] }),
  )
  const report = buildReviewReport(input, now)
  // 编号按 start 排序：b1(start0)=1, b3(start1)=2, b2(start2)=3
  assert.ok(report.html.includes('id="ann-1"'))
  assert.ok(report.html.includes('id="ann-2"'))
  assert.ok(report.html.includes('id="ann-3"'))
  // 上标芯片 1、2 出现在 start=0/1 的段起点；检查芯片总数（每条标注一个）
  const chips = report.html.match(/class="rep-chip"/g) ?? []
  assert.strictEqual(chips.length, 3, '每条非空区间标注在其区间起点有一个序号芯片')
  console.log('  ✓ 多标注叠加与按原文位置编号')
}

// 8. 关系基数上限审计：规则随报告快照输出违规；不阻止关系存在
{
  const capText = '甲乙丙丁戊己'
  const input: ReportInput = {
    title: '基数文档',
    text: capText,
    annotations: [
      mkAnn({ id: 'k1', quote: '甲', start: 0, end: 1 }),
      mkAnn({ id: 'k2', quote: '乙', start: 1, end: 2 }),
      mkAnn({ id: 'k3', quote: '丙', start: 2, end: 3 }),
      mkAnn({ id: 'k4', quote: '丁', start: 3, end: 4 }),
    ],
    conflictRules: [],
    ignoredConflicts: [],
    coverageTags: [],
    relations: [
      // k1 的两条「支撑」出边：早的保留、晚的源端超限
      { id: 'kr1', sourceId: 'k1', targetId: 'k2', type: '支撑', createdAt: 1 },
      { id: 'kr2', sourceId: 'k1', targetId: 'k3', type: '支撑', createdAt: 2 },
      // k4 收到两条「支撑」入边：kr1 之外还有 kr3 → kr3 目标端超限
      { id: 'kr3', sourceId: 'k2', targetId: 'k4', type: '支撑', createdAt: 3 },
      { id: 'kr4', sourceId: 'k3', targetId: 'k4', type: '支撑', createdAt: 4 },
    ],
    relationCardinalityRules: [
      { id: 'kc1', type: '支撑', maxOut: 1, maxIn: 1, createdAt: 1 },
    ],
  }
  const report = buildReviewReport(input, now)
  // 出边：k1 有 kr1/kr2 → kr2 源端超限；k2 有 kr3 → 不超
  // 入边：k4 有 kr3/kr4 → kr4 目标端超限
  // 4 条关系全部有效；违规 2 条
  assert.strictEqual(report.stats.relationsActive, 4)
  assert.strictEqual(report.stats.relationsInvalid, 0)
  assert.strictEqual(report.stats.relationOverLimit, 2)
  assert.ok(report.html.includes('关系基数违规（2）'), '应有基数违规分区与计数')
  assert.ok(report.html.includes('源端超限'), '应注明源端超限')
  assert.ok(report.html.includes('目标端超限'), '应注明目标端超限')
  assert.ok(report.html.includes('id="relation-over-1"'), '违规明细应有独立锚点')
  assert.ok(report.html.includes('最多 1 条出边（实际 2 条）'), '应列名额与实际出边数')
  assert.ok(report.html.includes('每条目标标注最多 1 条入边（实际 2 条）'), '应列名额与实际入边数')
  // 有效关系分区内违规卡片带 rep-rel-over 样式
  assert.ok(/id="relation-active-\d+" class="rep-rel rep-rel-over"/.test(report.html))
  // 基数违规为 0 的报告不出现警告分区文案
  const clean = buildReviewReport({ ...input, relationCardinalityRules: [] }, now)
  assert.strictEqual(clean.stats.relationOverLimit, 0)
  assert.ok(clean.html.includes('没有超出基数上限的有效关系'))
  console.log('  ✓ 关系基数审计：源端/目标端违规标记、名额文案与统计')
}

// 9. 非空原文但没有有效已绑定区间（无标注 / 仅剩待处理）：原文区仍输出完整原文，
//    不出现「原文为空」占位；空原文时才输出空正文
for (const [label, annotations] of [
  ['无标注', []],
  [
    '仅剩待处理标注',
    [
      mkAnn({
        id: 'p1',
        quote: '已消失的引文XYZ',
        start: 0,
        end: 0,
        status: 'pending',
        pendingReason: '原文中已找不到该引文，需要手动重新选择',
      }),
    ],
  ],
] as const) {
  const report = buildReviewReport(
    {
      title: '无有效区间文档',
      text,
      annotations: annotations as Annotation[],
      conflictRules: [],
      ignoredConflicts: [],
      coverageTags: [],
    },
    now,
  )
  // 去掉内嵌样式表，避免样式文本干扰正文匹配
  const bodyHtml = report.html.replace(/<style>[\s\S]*?<\/style>/, '')
  const m = bodyHtml.match(/<article class="rep-text">([\s\S]*?)<\/article>/)
  assert.ok(m, `${label}时应有原文区`)
  assert.strictEqual(m![1], text, `${label}时原文区应是无标注的完整原文一段`)
  assert.ok(!bodyHtml.includes('（原文为空）'), `${label}时不应显示原文为空占位`)
}
{
  const report = buildReviewReport(
    {
      title: '真空文档',
      text: '',
      annotations: [],
      conflictRules: [],
      ignoredConflicts: [],
      coverageTags: [],
    },
    now,
  )
  const bodyHtml = report.html.replace(/<style>[\s\S]*?<\/style>/, '')
  assert.ok(bodyHtml.includes('<span class="rep-muted">（原文为空）</span>'),
    '空原文才显示原文为空占位')
}
console.log('  ✓ 非空原文无有效已绑定区间时报告正文仍完整输出；空原文才为空')

console.log('\n审阅报告生成测试全部通过')
