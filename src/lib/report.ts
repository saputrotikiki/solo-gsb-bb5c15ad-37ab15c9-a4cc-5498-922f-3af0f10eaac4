// 审阅报告：基于当前文档快照生成自包含 HTML（内嵌样式，无任何外部资源）。
//
// 纯函数：只读取传入数据、不修改任何字段、不触碰 localStorage。
// 报告内容：
//   1. 开头汇总：标注总数、待处理数、未忽略冲突数、覆盖问题数、有效 / 失效关系数、基数违规数；
//   2. 按原文位置渲染的全文：已绑定标注的高亮（多色叠加）、冲突交叠描边、覆盖缺口/重叠底色，
//      段首上标序号可跳到对应标注明细；
//   3. 已绑定标注明细（引文、位置、标签、备注）；
//   4. 待处理标注（引文、标签、备注、待处理原因）；
//   5. 未忽略冲突及冲突双方（引文、标签、位置、备注、交叠原文）；
//   6. 覆盖审计问题（缺口 / 重叠的原文摘录、位置与涉及标注）；
//   7. 标注关系：有效关系（基数违规注明源端 / 目标端 / 两者）、基数违规汇总、失效关系（注明原因）。

import type {
  Annotation,
  AnnotationRelation,
  ConflictRule,
  IgnoredConflict,
  RelationCardinalityRule,
} from '../types'
import {
  badgeColor,
  blendedColor,
  buildSegments,
} from './segments'
import {
  activeConflictRanges,
  detectConflicts,
  isConflictSegment,
} from './conflicts'
import { auditCoverage } from './coverage'
import {
  auditRelationCardinality,
  buildRelationViews,
  cardinalityLimitText,
  CARDINALITY_SIDE_LABEL,
  relationStats,
  RELATION_INVALID_REASON_LABEL,
  sortRelationViews,
} from './relations'

export interface ReportInput {
  title: string
  text: string
  annotations: Annotation[]
  conflictRules: ConflictRule[]
  ignoredConflicts: IgnoredConflict[]
  coverageTags: string[]
  /** 标注之间的有向关系（旧版调用方缺省时按空数组处理） */
  relations?: AnnotationRelation[]
  /** 关系基数上限规则（旧版调用方缺省时按空数组处理：无违规） */
  relationCardinalityRules?: RelationCardinalityRule[]
}

export interface ReportStats {
  /** 标注总数（含待处理） */
  total: number
  /** 待处理数 */
  pending: number
  /** 未忽略冲突数 */
  conflicts: number
  /** 覆盖问题数（缺口 + 重叠；未配置覆盖标签时为 0） */
  coverageIssues: number
  /** 有效关系数（两端标注均存在且已绑定） */
  relationsActive: number
  /** 失效关系数（任一端被删除或进入待处理） */
  relationsInvalid: number
  /** 基数上限违规关系数（去重：同一条源 / 目标都超限只算一条） */
  relationOverLimit: number
}

export interface ReviewReport {
  /** 自包含 HTML 文档字符串 */
  html: string
  /** 建议的下载文件名（含文档标题与日期） */
  filename: string
  stats: ReportStats
  /** 报告生成时间（即传入的 now） */
  generatedAt: Date
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 保留换行：white-space: pre-wrap 已保留空格，这里仅把换行转为 <br> */
function htmlWithBreaks(raw: string): string {
  return escapeHtml(raw).replace(/\r\n|\r|\n/g, '<br>')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时区的 YYYY-MM-DD HH:mm */
export function formatLocalDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 文件名安全片段：与 JSON / JSONL 导出同一套替换规则 */
export function safeFilePart(title: string): string {
  return title.replace(/[\\/:*?"<>|\s]+/g, '_') || '未命名文档'
}

/** 去除非法字符后只剩下划线 / 空串时回退为默认名（与 JSONL 导出口径一致） */
function filenameTitlePart(title: string): string {
  const replaced = title.replace(/[\\/:*?"<>|\s]+/g, '_')
  return /^_+$/.test(replaced) || replaced === '' ? '未命名文档' : replaced
}

/** 报告文件名：审阅报告_<标题>_<YYYY-MM-DD>.html（日期口径与其它导出一致，取 UTC 日期） */
export function reportFilename(title: string, now: Date): string {
  return `审阅报告_${filenameTitlePart(title)}_${now.toISOString().slice(0, 10)}.html`
}

/** 触发浏览器下载（纯前端 Blob，不写入任何本地数据） */
export function downloadHtmlFile(filename: string, html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function tagsHtml(tags: string[]): string {
  if (tags.length === 0) return '<span class="rep-muted">（无标签）</span>'
  return tags.map((t) => `<span class="rep-tag">#${escapeHtml(t)}</span>`).join('')
}

/**
 * 基于当前文档快照生成审阅报告。
 * 纯函数：相同输入必得相同输出，且不修改输入对象。
 */
export function buildReviewReport(input: ReportInput, now: Date = new Date()): ReviewReport {
  const { title, text, annotations } = input

  const conflicts = detectConflicts(
    annotations,
    input.conflictRules,
    input.ignoredConflicts,
  )
  const activeConflicts = conflicts.filter((c) => !c.ignored)
  const ignoredConflictCount = conflicts.length - activeConflicts.length
  const coverage = auditCoverage(annotations, text.length, input.coverageTags)

  // 标注关系：有效性由两端标注派生（与侧栏口径一致）
  const relations = input.relations ?? []
  const cardinalityRules = input.relationCardinalityRules ?? []
  const relationViews = sortRelationViews(buildRelationViews(relations, annotations))
  const relStats = relationStats(relationViews)
  // 基数上限审计：仅统计有效关系（与侧栏同一纯函数）
  const cardinality = auditRelationCardinality(relationViews, cardinalityRules)
  const overById = cardinality.violationById

  const pendingAnnotations = annotations
    .filter((a) => a.status === 'pending')
    .sort((x, y) => y.updatedAt - x.updatedAt)
  // 已绑定标注按原文位置编号：start、end、id 决胜，序号用于原文上标与明细锚点
  const boundAnnotations = annotations
    .filter((a) => a.status === 'bound')
    .sort((x, y) => x.start - y.start || x.end - y.end || x.id.localeCompare(y.id))
  const numberById = new Map(boundAnnotations.map((a, i) => [a.id, i + 1]))
  const annById = new Map(annotations.map((a) => [a.id, a]))

  // 可在原文中渲染的（区间非空）已绑定标注
  const highlightable = boundAnnotations.filter((a) => a.end > a.start)
  const segments = buildSegments(
    text.length,
    highlightable.map((a) => ({ start: a.start, end: a.end, id: a.id })),
  )
  const conflictRanges = activeConflictRanges(activeConflicts)

  // 段起点 → 恰好在该起点开始的标注序号（上标芯片）
  const chipsByStart = new Map<number, number[]>()
  for (const a of highlightable) {
    const list = chipsByStart.get(a.start)
    const n = numberById.get(a.id)!
    if (list) list.push(n)
    else chipsByStart.set(a.start, [n])
  }

  const stats: ReportStats = {
    total: annotations.length,
    pending: pendingAnnotations.length,
    conflicts: activeConflicts.length,
    coverageIssues: coverage.gapCount + coverage.overlapCount,
    relationsActive: relStats.active,
    relationsInvalid: relStats.invalid,
    relationOverLimit: cardinality.count,
  }

  // ---------- 原文（按位置渲染高亮 / 冲突 / 覆盖问题） ----------

  const bodyParts: string[] = []
  for (const seg of segments) {
    const slice = text.slice(seg.start, seg.end)
    const chips = (chipsByStart.get(seg.start) ?? [])
      .map(
        (n) =>
          `<a class="rep-chip" href="#ann-${n}" title="跳到标注 ${n}">${n}</a>`,
      )
      .join('')
    const chipHtml = chips ? `<sup class="rep-chips">${chips}</sup>` : ''
    const coverageKind = coverage.marksByStart.get(seg.start) ?? null

    if (seg.annotationIds.length === 0) {
      if (coverageKind) {
        bodyParts.push(
          `<mark class="rep-cov rep-cov-${coverageKind}">${chipHtml}${htmlWithBreaks(slice)}</mark>`,
        )
      } else {
        bodyParts.push(`${chipHtml}${htmlWithBreaks(slice)}`)
      }
      continue
    }

    const nums = seg.annotationIds.map((id) => numberById.get(id)).filter((n): n is number => !!n)
    const tagPreview = seg.annotationIds
      .map((id) => annById.get(id))
      .filter((a): a is Annotation => !!a)
      .map((a) => `${numberById.get(a.id)} 号：${a.tags.length ? a.tags.map((t) => `#${t}`).join(' ') : '无标签'}`)
      .join('；')
    const isConflict = isConflictSegment(conflictRanges, seg.start, seg.end)
    const bgClass = coverageKind ? ` rep-cov rep-cov-${coverageKind}` : ''
    const conflictClass = isConflict ? ' rep-hl-conflict' : ''
    // 覆盖问题底色优先（用于审计标识）；否则按叠加标注混合配色
    const style = coverageKind
      ? ''
      : ` style="background-color: ${blendedColor(seg.annotationIds)};"`
    bodyParts.push(
      `<mark class="rep-hl${conflictClass}${bgClass}"${style} ` +
        `title="标注 ${nums.join('、')}（${escapeHtml(tagPreview)}）">` +
        `${chipHtml}${htmlWithBreaks(slice)}</mark>`,
    )
  }
  const textHtml = bodyParts.join('')

  // ---------- 已绑定标注明细 ----------

  const detailItems = boundAnnotations
    .map((a) => {
      const n = numberById.get(a.id)!
      const length = Math.max(0, a.end - a.start)
      return (
        `<li id="ann-${n}" class="rep-ann">` +
        `<div class="rep-ann-head"><span class="rep-ann-num" style="background-color:${badgeColor(a.id)}">${n}</span>` +
        `<span class="rep-ann-pos">[${a.start}, ${a.end}) · ${length} 字</span></div>` +
        `<blockquote class="rep-quote">${htmlWithBreaks(a.quote) || '<span class="rep-muted">（空引文）</span>'}</blockquote>` +
        `<div class="rep-tags">${tagsHtml(a.tags)}</div>` +
        `<p class="rep-note">${htmlWithBreaks(a.note) || '<span class="rep-muted">（无备注）</span>'}</p>` +
        `</li>`
      )
    })
    .join('')

  // ---------- 待处理标注 ----------

  const pendingItems = pendingAnnotations
    .map((a, i) => {
      const reason = a.pendingReason ? `<p class="rep-reason">${escapeHtml(a.pendingReason)}</p>` : ''
      return (
        `<li class="rep-pending-item">` +
        `<div class="rep-ann-head"><span class="rep-pending-flag">待处理 ${i + 1}</span>` +
        `<span class="rep-ann-pos">更新于 ${formatLocalDateTime(new Date(a.updatedAt))}</span></div>` +
        `<blockquote class="rep-quote">${htmlWithBreaks(a.quote) || '<span class="rep-muted">（空引文）</span>'}</blockquote>` +
        `<div class="rep-tags">${tagsHtml(a.tags)}</div>` +
        `<p class="rep-note">${htmlWithBreaks(a.note) || '<span class="rep-muted">（无备注）</span>'}</p>` +
        reason +
        `</li>`
      )
    })
    .join('')

  // ---------- 冲突双方 ----------

  const conflictSide = (a: Annotation, n: number | undefined) => {
    const numBadge = n
      ? `<a class="rep-ann-num rep-ann-num-link" href="#ann-${n}">${n}</a>`
      : '<span class="rep-ann-num rep-ann-num-pending">!</span>'
    return (
      `<div class="rep-conflict-side">` +
      `<div class="rep-ann-head">${numBadge}` +
      `<span class="rep-ann-pos">[${a.start}, ${a.end})</span></div>` +
      `<blockquote class="rep-quote">${htmlWithBreaks(a.quote) || '<span class="rep-muted">（空引文）</span>'}</blockquote>` +
      `<div class="rep-tags">${tagsHtml(a.tags)}</div>` +
      `<p class="rep-note">${htmlWithBreaks(a.note) || '<span class="rep-muted">（无备注）</span>'}</p>` +
      `</div>`
    )
  }

  const conflictItems = activeConflicts
    .map((c, i) => {
      const a = annById.get(c.annotationIds[0])
      const b = annById.get(c.annotationIds[1])
      if (!a || !b) return ''
      const rules = c.rules
        .map((r) => `<span class="rep-rule">${escapeHtml(r.tagA)} ⇄ ${escapeHtml(r.tagB)}</span>`)
        .join('')
      const overlap = text.slice(c.overlapStart, c.overlapEnd)
      return (
        `<li id="conflict-${i + 1}" class="rep-conflict">` +
        `<div class="rep-conflict-rules">${rules}</div>` +
        `<div class="rep-conflict-sides">` +
        conflictSide(a, numberById.get(a.id)) +
        `<div class="rep-vs">⇄</div>` +
        conflictSide(b, numberById.get(b.id)) +
        `</div>` +
        `<p class="rep-overlap"><span class="rep-overlap-label">交叠原文（[${c.overlapStart}, ${c.overlapEnd})）：</span>` +
        `「${htmlWithBreaks(overlap) || '<span class="rep-muted">（空）</span>'}」</p>` +
        `</li>`
      )
    })
    .join('')

  // ---------- 覆盖问题 ----------

  const coverageItems = coverage.issues
    .map((item) => {
      const quote = text.slice(item.start, item.end)
      const length = item.end - item.start
      const flag = item.kind === 'gap'
        ? '<span class="rep-cov-flag rep-cov-flag-gap">缺口</span>'
        : '<span class="rep-cov-flag rep-cov-flag-overlap">重叠</span>'
      const involved =
        item.kind === 'overlap' && item.annotations.length > 0
          ? `<ul class="rep-cov-anns">${item.annotations
              .map((ca) => {
                const n = numberById.get(ca.id)
                const head = n
                  ? `<a href="#ann-${n}">标注 ${n}</a>`
                  : escapeHtml(ca.id)
                return `<li>${head} · <span class="rep-tags-inline">${tagsHtml(ca.tags)}</span> ` +
                  `「${htmlWithBreaks(ca.quote) || '<span class="rep-muted">（空引文）</span>'}」</li>`
              })
              .join('')}</ul>`
          : ''
      return (
        `<li class="rep-cov-item">${flag}` +
        `<span class="rep-ann-pos">[${item.start}, ${item.end}) · ${length} 字</span>` +
        `<blockquote class="rep-quote">${htmlWithBreaks(quote) || '<span class="rep-muted">（空区间）</span>'}</blockquote>` +
        involved +
        `</li>`
      )
    })
    .join('')

  // ---------- 标注关系 ----------

  /** 关系一端：已绑定标注可跳到明细锚点；待处理 / 已删除显示状态说明 */
  const relationEnd = (
    label: string,
    a: Annotation | null,
    missingLabel: string,
  ): string => {
    if (!a) {
      return (
        `<div class="rep-rel-side">` +
        `<div class="rep-ann-head"><span class="rep-rel-role">${label}</span>` +
        `<span class="rep-rel-state rep-rel-state-missing">${escapeHtml(missingLabel)}</span></div>` +
        `</div>`
      )
    }
    const n = numberById.get(a.id)
    const numBadge = n
      ? `<a class="rep-ann-num rep-ann-num-link" href="#ann-${n}">${n}</a>`
      : '<span class="rep-ann-num rep-ann-num-pending">!</span>'
    const state =
      a.status === 'pending'
        ? '<span class="rep-rel-state rep-rel-state-pending">待处理</span>'
        : ''
    return (
      `<div class="rep-rel-side">` +
      `<div class="rep-ann-head"><span class="rep-rel-role">${label}</span>${numBadge}${state}` +
      (n ? `<span class="rep-ann-pos">[${a.start}, ${a.end})</span>` : '') +
      `</div>` +
      `<blockquote class="rep-quote">${htmlWithBreaks(a.quote) || '<span class="rep-muted">（空引文）</span>'}</blockquote>` +
      `<div class="rep-tags">${tagsHtml(a.tags)}</div>` +
      `</div>`
    )
  }

  const buildRelationItem = (
    v: (typeof relationViews)[number],
    i: number,
    idPrefix: 'active' | 'invalid' | 'over',
  ): string => {
    const over = overById.get(v.relation.id)
    const cls = `${v.active ? 'rep-rel' : 'rep-rel rep-rel-invalid'}${over ? ' rep-rel-over' : ''}`
    const overState = over
      ? `<p class="rep-rel-over"><span class="rep-rel-over-flag rep-rel-over-${over.side}">${
          CARDINALITY_SIDE_LABEL[over.side]
        }</span>${escapeHtml(cardinalityLimitText(over))}</p>`
      : ''
    const state = v.active
      ? overState
      : `<p class="rep-rel-reason">已失效：${
          v.invalidReason ? escapeHtml(RELATION_INVALID_REASON_LABEL[v.invalidReason]) : ''
        }</p>`
    return (
      `<li id="relation-${idPrefix}-${i + 1}" class="${cls}">` +
      `<div class="rep-rel-type"><span class="rep-rel-type-pill">${escapeHtml(v.relation.type)}</span></div>` +
      `<div class="rep-rel-sides">` +
      relationEnd('源', v.source, '源标注已删除') +
      `<div class="rep-rel-arrow">→</div>` +
      relationEnd('目标', v.target, '目标标注已删除') +
      `</div>` +
      state +
      `</li>`
    )
  }
  const activeRelationViews = relationViews.filter((v) => v.active)
  const invalidRelationViews = relationViews.filter((v) => !v.active)
  const activeRelationItems = activeRelationViews
    .map((v, i) => buildRelationItem(v, i, 'active'))
    .join('')
  const invalidRelationItems = invalidRelationViews
    .map((v, i) => buildRelationItem(v, i, 'invalid'))
    .join('')
  // 基数违规明细：按审计自身的稳定顺序（创建时间 → 关系 ID）列出
  const overRelationItems = cardinality.violations
    .map((c, i) => buildRelationItem(c.view, i, 'over'))
    .join('')

  // ---------- 组装 ----------

  const escTitle = escapeHtml(title || '未命名文档')
  const coverageConfigNote = input.coverageTags.length > 0
    ? `覆盖审计标签：${input.coverageTags.map((t) => escapeHtml(t)).join('、')}`
    : '尚未配置覆盖审计标签（覆盖问题数始终为 0）'

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>审阅报告 · ${escTitle}</title>
<style>${REPORT_STYLES}</style>
</head>
<body>
<main class="rep-doc">
  <header class="rep-header">
    <h1>审阅报告</h1>
    <p class="rep-subtitle">${escTitle}</p>
    <p class="rep-meta">生成时间：${formatLocalDateTime(now)} · 原文 ${text.length} 字 · 已绑定 ${boundAnnotations.length} 条 · ${coverageConfigNote}</p>
  </header>

  <section class="rep-section">
    <h2>汇总</h2>
    <ul class="rep-stats">
      <li class="rep-stat"><span class="rep-stat-num">${stats.total}</span><span class="rep-stat-label">标注总数</span></li>
      <li class="rep-stat${stats.pending > 0 ? ' rep-stat-warn' : ''}"><span class="rep-stat-num">${stats.pending}</span><span class="rep-stat-label">待处理</span></li>
      <li class="rep-stat${stats.conflicts > 0 ? ' rep-stat-warn' : ''}"><span class="rep-stat-num">${stats.conflicts}</span><span class="rep-stat-label">冲突</span></li>
      <li class="rep-stat${stats.coverageIssues > 0 ? ' rep-stat-warn' : ''}"><span class="rep-stat-num">${stats.coverageIssues}</span><span class="rep-stat-label">覆盖问题</span></li>
      <li class="rep-stat"><span class="rep-stat-num">${stats.relationsActive}</span><span class="rep-stat-label">有效关系</span></li>
      <li class="rep-stat${stats.relationsInvalid > 0 ? ' rep-stat-warn' : ''}"><span class="rep-stat-num">${stats.relationsInvalid}</span><span class="rep-stat-label">失效关系</span></li>
      <li class="rep-stat${stats.relationOverLimit > 0 ? ' rep-stat-warn' : ''}"><span class="rep-stat-num">${stats.relationOverLimit}</span><span class="rep-stat-label">基数违规</span></li>
    </ul>
    <p class="rep-meta">冲突仅统计未忽略项${ignoredConflictCount > 0 ? `（另有 ${ignoredConflictCount} 条已忽略）` : ''}；覆盖问题为缺口与重叠之和。有效关系要求两端标注均存在且已绑定；任一端删除或待处理即计入失效关系。基数违规仅统计有效关系：同一端点同一类型按创建时间、再按关系 ID 排序后超出每源出边 / 每目标入边名额的关系；同一条两端都超限时只计一条。</p>
  </section>

  <section class="rep-section">
    <h2>原文与高亮</h2>
    <p class="rep-meta">背景色为已绑定标注（多色叠加）；红色波浪下划线为未忽略冲突的交叠区间；红色底为覆盖缺口、橙色底为覆盖重叠。点击高亮前的序号可跳到标注明细。</p>
    <article class="rep-text">${textHtml || '<span class="rep-muted">（原文为空）</span>'}</article>
  </section>

  <section class="rep-section">
    <h2>已绑定标注（${boundAnnotations.length}）</h2>
    ${
      boundAnnotations.length === 0
        ? '<p class="rep-muted">没有已绑定标注。</p>'
        : `<ol class="rep-ann-list">${detailItems}</ol>`
    }
  </section>

  <section class="rep-section">
    <h2>待处理标注（${pendingAnnotations.length}）</h2>
    ${
      pendingAnnotations.length === 0
        ? '<p class="rep-muted">没有待处理标注。</p>'
        : `<ol class="rep-pending-list">${pendingItems}</ol>`
    }
  </section>

  <section class="rep-section">
    <h2>冲突（${activeConflicts.length}）</h2>
    ${
      activeConflicts.length === 0
        ? '<p class="rep-muted">没有未忽略冲突。</p>'
        : `<ol class="rep-conflict-list">${conflictItems}</ol>`
    }
  </section>

  <section class="rep-section">
    <h2>覆盖问题（${stats.coverageIssues}）</h2>
    ${
      stats.coverageIssues === 0
        ? `<p class="rep-muted">${input.coverageTags.length > 0 ? '所选标签覆盖下没有缺口或重叠。' : '未配置覆盖审计标签。'}</p>`
        : `<ul class="rep-cov-list">${coverageItems}</ul>`
    }
  </section>

  <section class="rep-section">
    <h2>标注关系 · 有效（${activeRelationViews.length}）</h2>
    ${
      activeRelationViews.length === 0
        ? '<p class="rep-muted">没有有效关系。</p>'
        : `<ol class="rep-rel-list">${activeRelationItems}</ol>`
    }
  </section>

  <section class="rep-section">
    <h2>关系基数违规（${cardinality.count}）</h2>
    ${
      cardinality.count === 0
        ? '<p class="rep-muted">没有超出基数上限的有效关系。</p>'
        : `<p class="rep-meta">仅统计有效关系；同一端点同一类型按创建时间、再按关系 ID 稳定排序，超出每源出边 / 每目标入边名额的关系列出如下（同一条两端都超限只列一次）。</p><ol class="rep-rel-list">${overRelationItems}</ol>`
    }
  </section>

  <section class="rep-section">
    <h2>失效关系（${invalidRelationViews.length}）</h2>
    ${
      invalidRelationViews.length === 0
        ? '<p class="rep-muted">没有失效关系。</p>'
        : `<p class="rep-meta">下列关系因某端标注被删除或进入待处理而失效；待处理端重新绑定后关系自动恢复。</p><ol class="rep-rel-list">${invalidRelationItems}</ol>`
    }
  </section>

  <footer class="rep-footer">
    本报告由「原文锚点标注台」基于生成时刻的文档快照导出，为自包含 HTML 文件，可离线打开；报告不修改标注台本地数据。
  </footer>
</main>
</body>
</html>
`

  return {
    html,
    filename: reportFilename(title, now),
    stats,
    generatedAt: now,
  }
}

const REPORT_STYLES = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #f4f5f7;
  color: #1f2329;
  font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
.rep-doc { max-width: 920px; margin: 0 auto; padding: 32px 28px 56px; }
.rep-header h1 { margin: 0 0 4px; font-size: 28px; }
.rep-subtitle { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
.rep-meta { margin: 4px 0; color: #6b7280; font-size: 13px; }
.rep-section {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 18px 22px;
  margin: 18px 0;
}
.rep-section h2 { margin: 0 0 12px; font-size: 18px; }
.rep-muted { color: #9ca3af; }
.rep-stats {
  list-style: none; display: flex; flex-wrap: wrap; gap: 12px;
  margin: 8px 0 10px; padding: 0;
}
.rep-stat {
  flex: 1 1 140px; min-width: 140px;
  border: 1px solid #e5e7eb; border-radius: 8px;
  padding: 12px 16px; display: flex; flex-direction: column; gap: 2px;
  background: #fafbfc;
}
.rep-stat-num { font-size: 30px; font-weight: 700; line-height: 1.2; }
.rep-stat-label { color: #6b7280; font-size: 13px; }
.rep-stat-warn { border-color: #f0b8b4; background: #fdf3f2; }
.rep-stat-warn .rep-stat-num { color: #c0392b; }
.rep-text {
  white-space: pre-wrap; word-break: break-word;
  background: #fdfdfc; border: 1px solid #eee; border-radius: 8px;
  padding: 16px 18px; font-size: 15.5px; line-height: 2;
}
.rep-hl { border-radius: 3px; padding: 0 1px; }
.rep-hl-conflict {
  box-shadow: inset 0 -2px 0 #fff, inset 0 -4px 0 rgba(220, 38, 38, 0.85);
}
.rep-cov-gap { background-color: rgba(229, 57, 53, 0.22) !important; outline: 1px dashed rgba(229, 57, 53, 0.7); }
.rep-cov-overlap { background-color: rgba(245, 158, 11, 0.28) !important; outline: 1px dashed rgba(217, 119, 6, 0.7); }
.rep-chips { margin-right: 1px; }
.rep-chip {
  display: inline-block; min-width: 16px; padding: 0 4px; margin: 0 1px;
  font-size: 11px; font-weight: 700; line-height: 16px; text-align: center;
  background: #1f6feb; color: #fff !important; border-radius: 8px;
  text-decoration: none; vertical-align: super;
}
.rep-ann-list, .rep-pending-list, .rep-conflict-list, .rep-cov-list { margin: 0; padding: 0; list-style: none; }
.rep-ann, .rep-pending-item, .rep-conflict, .rep-cov-item {
  border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; margin: 10px 0;
  scroll-margin-top: 12px;
}
.rep-pending-item { border-color: #f0b8b4; background: #fdf3f2; }
.rep-ann-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rep-ann-num {
  display: inline-block; min-width: 22px; height: 22px; padding: 0 6px;
  border-radius: 11px; color: rgba(0, 0, 0, 0.62);
  font-size: 12px; font-weight: 700; line-height: 22px; text-align: center;
}
.rep-ann-num-link { color: rgba(0, 0, 0, 0.62) !important; text-decoration: none; }
.rep-ann-num-pending { background: #e5e7eb; color: #374151; }
.rep-ann-pos { color: #6b7280; font-size: 12.5px; }
.rep-pending-flag {
  display: inline-block; padding: 1px 10px; border-radius: 10px;
  background: #c0392b; color: #fff; font-size: 12px; font-weight: 700;
}
.rep-quote {
  margin: 8px 0; padding: 6px 12px;
  border-left: 3px solid #c7ccd4; background: #f7f8fa;
  border-radius: 0 6px 6px 0; white-space: pre-wrap; word-break: break-word;
}
.rep-tags { margin: 4px 0; }
.rep-tag {
  display: inline-block; margin: 2px 4px 2px 0; padding: 1px 8px;
  background: #eaf2ff; color: #1856b0; border-radius: 10px; font-size: 12.5px;
}
.rep-tags-inline { display: inline; }
.rep-note { margin: 6px 0 2px; }
.rep-reason { margin: 6px 0 2px; color: #c0392b; font-size: 13px; }
.rep-conflict-rules { margin: 2px 0 8px; }
.rep-rule {
  display: inline-block; margin: 2px 6px 2px 0; padding: 1px 10px;
  background: #fdecea; color: #b3261e; border: 1px solid #f5c6c2;
  border-radius: 10px; font-size: 12.5px; font-weight: 600;
}
.rep-conflict-sides { display: flex; gap: 10px; align-items: stretch; }
.rep-conflict-side { flex: 1 1 0; border: 1px solid #eee; border-radius: 8px; padding: 8px 10px; min-width: 0; }
.rep-vs { align-self: center; color: #b3261e; font-weight: 700; }
.rep-conflict-side .rep-quote { margin: 6px 0; }
.rep-overlap { margin: 8px 0 2px; }
.rep-overlap-label { color: #6b7280; font-size: 13px; }
.rep-cov-flag {
  display: inline-block; margin-right: 8px; padding: 1px 10px;
  border-radius: 10px; color: #fff; font-size: 12.5px; font-weight: 700;
}
.rep-cov-flag-gap { background: #e53935; }
.rep-cov-flag-overlap { background: #f59e0b; }
.rep-cov-anns { margin: 6px 0 0; padding-left: 20px; }
.rep-cov-anns li { margin: 4px 0; }
.rep-rel-list { margin: 0; padding: 0; list-style: none; }
.rep-rel {
  border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 14px; margin: 10px 0;
  scroll-margin-top: 12px;
}
.rep-rel-invalid { border-color: #e5c07b; background: #fdf8ec; }
.rep-rel-over { border-color: #efb3af; background: #fdf4f3; box-shadow: inset 3px 0 0 #d9534f; }
p.rep-rel-over { color: #b3261e; margin: 8px 0 2px; font-size: 13px; }
.rep-rel-over-flag {
  display: inline-block; margin-right: 8px; padding: 1px 10px;
  border-radius: 10px; color: #fff; font-size: 12.5px; font-weight: 700;
  background: #d9534f;
}
.rep-rel-type { margin: 2px 0 8px; }
.rep-rel-type-pill {
  display: inline-block; padding: 1px 10px;
  background: #eef0ff; color: #4338ca; border: 1px solid #d4d8ff;
  border-radius: 10px; font-size: 12.5px; font-weight: 600;
}
.rep-rel-sides { display: flex; gap: 10px; align-items: stretch; }
.rep-rel-side { flex: 1 1 0; border: 1px solid #eee; border-radius: 8px; padding: 8px 10px; min-width: 0; }
.rep-rel-arrow { align-self: center; color: #4338ca; font-weight: 700; }
.rep-rel-role {
  display: inline-block; margin-right: 6px; padding: 0 8px; border-radius: 10px;
  background: #eef2ff; color: #4338ca; font-size: 12px; font-weight: 700;
}
.rep-rel-state { font-size: 12.5px; padding: 0 8px; border-radius: 10px; }
.rep-rel-state-pending { background: #fff7e6; color: #b26a00; }
.rep-rel-state-missing { background: #fdecea; color: #b3261e; }
.rep-rel-reason { margin: 8px 0 2px; color: #9a6b00; font-size: 13px; }
.rep-rel-side .rep-quote { margin: 6px 0; }
.rep-footer { color: #9ca3af; font-size: 12.5px; text-align: center; margin-top: 24px; }
@media print {
  body { background: #fff; }
  .rep-section { break-inside: avoid; border: none; padding: 8px 0; }
  .rep-chip { background: #555; }
}
`
