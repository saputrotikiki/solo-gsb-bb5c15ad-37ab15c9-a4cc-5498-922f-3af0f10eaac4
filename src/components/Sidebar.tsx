import { forwardRef } from 'react'
import type { RefObject } from 'react'
import type {
  Annotation,
  AnnotationBaseline,
  ConflictRule,
  RelationCardinalityRule,
  SampleConfig,
  SampleReview,
  SampleTarget,
  SampleVerdict,
} from '../types'
import { REASON_LABEL } from '../lib/relocation'
import { badgeColor } from '../lib/segments'
import type { ConflictItem } from '../lib/conflicts'
import type { CoverageIssue, CoverageResult } from '../lib/coverage'
import type { QuoteAudit } from '../lib/missingQuotes'
import type { SnapshotDiffItem } from '../lib/snapshot'
import type { SampleQueueResult } from '../lib/sampling'
import type { CardinalityViolation, RelationView } from '../lib/relations'
import { SnapshotSection } from './SnapshotSection'
import { SamplingSection } from './SamplingSection'
import { DatasetSplitSection } from './DatasetSplitSection'
import { BulkSection } from './BulkSection'
import { MissingQuoteSection } from './MissingQuoteSection'
import { RelationsSection } from './RelationsSection'

interface Props {
  /** 文档标题（训练集划分导出的 JSONL 每行需要） */
  title: string
  text: string
  annotations: Annotation[]
  activeId: string | null
  conflictRules: ConflictRule[]
  conflicts: ConflictItem[]
  /** 标签覆盖审计 */
  coverageTags: string[]
  coverageResult: CoverageResult
  activeCoverageKey: string | null
  onChangeCoverageTags: (tags: string[]) => void
  onFocusCoverage: (issue: CoverageIssue) => void
  /** 覆盖审计分区的滚动定位 ref（顶栏按钮用） */
  coverageSectionRef?: RefObject<HTMLElement | null>
  /** 同引文漏标审阅 */
  quoteTemplateId: string | null
  quoteAudit: QuoteAudit | null
  activeQuoteRange: { start: number; end: number } | null
  onChangeQuoteTemplate: (id: string | null) => void
  onBackfillQuotes: (
    positions: Array<{ start: number; end: number }>,
  ) => { created: number; skipped: number }
  onFocusQuoteOccurrence: (occ: { start: number; end: number }) => void
  /** 漏标审阅分区的滚动定位 ref（顶栏按钮用） */
  quoteSectionRef?: RefObject<HTMLElement | null>
  /** 标注快照对比 */
  baseline: AnnotationBaseline | null
  snapshotDiffs: SnapshotDiffItem[]
  reviewedKeys: Set<string>
  onSaveBaseline: () => void
  onClearBaseline: () => void
  onToggleReview: (item: SnapshotDiffItem) => void
  /** 快照对比分区的滚动定位 ref（顶栏按钮用） */
  snapshotSectionRef?: RefObject<HTMLElement | null>
  /** 抽样复核 */
  sampleConfig: SampleConfig | null
  sampleQueue: SampleQueueResult
  sampleReviews: SampleReview[]
  onSaveSampleConfig: (seed: string, targets: SampleTarget[]) => void
  onClearSampleConfig: () => void
  onSetSampleReview: (
    annotation: Annotation,
    verdict: SampleVerdict | null,
    note: string,
  ) => void
  /** 抽样复核分区的滚动定位 ref（顶栏按钮用） */
  samplingSectionRef?: RefObject<HTMLElement | null>
  /** 训练集划分导出分区的滚动定位 ref（顶栏按钮用） */
  datasetSplitSectionRef?: RefObject<HTMLElement | null>
  /** 标注关系 */
  relationViews: RelationView[]
  /** 关系基数上限审计违规（App 派生） */
  relationCardinality: CardinalityViolation[]
  relationCardinalityRules: RelationCardinalityRule[]
  onSaveRelationCardinalityRules: (rules: RelationCardinalityRule[]) => void
  onCreateRelation: (sourceId: string, targetId: string, type: string) => void
  onDeleteRelation: (id: string) => void
  /** 标注关系分区的滚动定位 ref（顶栏按钮用） */
  relationsSectionRef?: RefObject<HTMLElement | null>
  onFocus: (a: Annotation) => void
  onEdit: (a: Annotation) => void
  onRebindStart: (a: Annotation) => void
  onDelete: (a: Annotation) => void
  onFocusOverlap: (c: ConflictItem) => void
  onIgnore: (c: ConflictItem) => void
  onUnignore: (c: ConflictItem) => void
  onConfigureRules: () => void
  onRenameTags: () => void
  /** 批量操作：确认后一次性更新选中的标注标签，返回实际更新条数 */
  onBulkApply: (
    selectedIds: string[],
    mode: 'add' | 'remove',
    tags: string[],
  ) => number
  tagCount: number
  /** 当前全部标签（标注使用 + 规则引用），供抽样配置表单列出 */
  allTags: string[]
  /** 生成并下载自包含 HTML 审阅报告（使用当前文档快照，不修改本地数据） */
  onDownloadReport: () => void
}

/** 覆盖问题的稳定键：类型 + 起点（审计结果按起点唯一排列） */
export function coverageIssueKey(item: CoverageIssue): string {
  return `${item.kind}:${item.start}:${item.end}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function overlapQuote(text: string, c: ConflictItem): string {
  return text.slice(c.overlapStart, c.overlapEnd)
}

function AnnotationItem({
  a,
  active,
  onFocus,
  onEdit,
  onRebindStart,
  onDelete,
}: {
  a: Annotation
  active: boolean
} & Pick<Props, 'onFocus' | 'onEdit' | 'onRebindStart' | 'onDelete'>) {
  return (
    <div className={`ann-item ${active ? 'ann-active' : ''} ${a.status === 'pending' ? 'ann-pending' : ''}`}>
      <button
        type="button"
        className="ann-main"
        title="在原文中定位"
        onClick={() => (a.status === 'bound' ? onFocus(a) : onRebindStart(a))}
      >
        <span className="ann-badge" style={{ backgroundColor: badgeColor(a.id) }} />
        <span className="ann-quote">
          {a.status === 'pending' && <em className="ann-pending-flag">[待绑定] </em>}
          {a.quote || <span className="ann-empty-quote">（空引文）</span>}
        </span>
      </button>
      {a.tags.length > 0 && (
        <div className="ann-tags">
          {a.tags.map((t) => (
            <span className="ann-tag" key={t}>
              #{t}
            </span>
          ))}
        </div>
      )}
      {a.note && <p className="ann-note">{a.note}</p>}
      {a.status === 'pending' && a.pendingReason && (
        <p className="ann-pending-reason">{a.pendingReason}</p>
      )}
      {a.status === 'bound' && a.lastRelocation && (
        <p className="ann-meta">
          {REASON_LABEL[a.lastRelocation.reason]}
          {a.lastRelocation.reason === 'context-score' && `（${a.lastRelocation.score} 字）`}
          {' · '}
          {formatTime(a.lastRelocation.timestamp)}
        </p>
      )}
      <div className="ann-actions">
        {a.status === 'pending' ? (
          <button className="btn btn-small btn-warn" onClick={() => onRebindStart(a)}>
            重新选择片段
          </button>
        ) : (
          <button className="btn btn-small btn-ghost" onClick={() => onFocus(a)}>
            定位
          </button>
        )}
        <button className="btn btn-small btn-ghost" onClick={() => onEdit(a)}>
          编辑
        </button>
        <button
          className="btn btn-small btn-ghost btn-danger-text"
          onClick={() => {
            if (confirm('确定删除这条标注吗？')) onDelete(a)
          }}
        >
          删除
        </button>
      </div>
    </div>
  )
}

/** 冲突一方：引文、标签，定位 / 编辑按钮 */
function ConflictSide({
  a,
  active,
  onFocus,
  onEdit,
}: {
  a: Annotation
  active: boolean
  onFocus: (a: Annotation) => void
  onEdit: (a: Annotation) => void
}) {
  return (
    <div className={`conflict-side ${active ? 'conflict-side-active' : ''}`}>
      <div className="conflict-side-head">
        <span className="ann-badge" style={{ backgroundColor: badgeColor(a.id) }} />
        <span className="conflict-side-quote" title={a.quote}>
          {a.quote || <span className="ann-empty-quote">（空引文）</span>}
        </span>
      </div>
      {a.tags.length > 0 && (
        <div className="ann-tags">
          {a.tags.map((t) => (
            <span className="ann-tag" key={t}>
              #{t}
            </span>
          ))}
        </div>
      )}
      <div className="conflict-side-actions">
        <button className="btn btn-small btn-ghost" onClick={() => onFocus(a)}>
          定位
        </button>
        <button className="btn btn-small btn-ghost" onClick={() => onEdit(a)}>
          编辑
        </button>
      </div>
    </div>
  )
}

function ConflictCard({
  text,
  item,
  annById,
  activeId,
  onFocus,
  onEdit,
  onFocusOverlap,
  onIgnore,
  onUnignore,
}: {
  text: string
  item: ConflictItem
  annById: Map<string, Annotation>
  activeId: string | null
} & Pick<
  Props,
  'onFocus' | 'onEdit' | 'onFocusOverlap' | 'onIgnore' | 'onUnignore'
>) {
  const a = annById.get(item.annotationIds[0])
  const b = annById.get(item.annotationIds[1])
  if (!a || !b) return null
  const quote = overlapQuote(text, item)

  return (
    <div className={`conflict-item ${item.ignored ? 'conflict-ignored' : ''}`}>
      <div className="conflict-rules">
        {item.rules.map((r) => (
          <span className="conflict-rule-pill" key={r.id}>
            {r.tagA} ⇄ {r.tagB}
          </span>
        ))}
        {item.rules.length > 1 && <span className="conflict-rule-count">命中 {item.rules.length} 条规则</span>}
      </div>

      <div className="conflict-sides">
        <ConflictSide a={a} active={activeId === a.id} onFocus={onFocus} onEdit={onEdit} />
        <div className="conflict-vs">⇄</div>
        <ConflictSide a={b} active={activeId === b.id} onFocus={onFocus} onEdit={onEdit} />
      </div>

      <div className="conflict-overlap">
        <span className="conflict-overlap-label">交叠原文</span>
        <button type="button" className="conflict-overlap-quote" title="定位到交叠处" onClick={() => onFocusOverlap(item)}>
          「{quote}」
        </button>
      </div>

      <div className="conflict-item-actions">
        <span className="form-spacer" />
        {item.ignored ? (
          <button className="btn btn-small btn-ghost" onClick={() => onUnignore(item)}>
            取消忽略
          </button>
        ) : (
          <button className="btn btn-small btn-ghost" onClick={() => onIgnore(item)}>
            忽略此冲突
          </button>
        )}
      </div>
    </div>
  )
}

/** 缺口 / 重叠结果卡片 */
function CoverageCard({
  text,
  item,
  annById,
  active,
  onFocusIssue,
  onFocusAnnotation,
  onEdit,
}: {
  text: string
  item: CoverageIssue
  annById: Map<string, Annotation>
  active: boolean
  onFocusIssue: (item: CoverageIssue) => void
  onFocusAnnotation: (a: Annotation) => void
  onEdit: (a: Annotation) => void
}) {
  const quote = text.slice(item.start, item.end)
  const length = item.end - item.start
  return (
    <div className={`cov-item cov-item-${item.kind} ${active ? 'cov-item-active' : ''}`}>
      <button
        type="button"
        className="cov-main"
        title="在原文中定位该区间"
        onClick={() => onFocusIssue(item)}
      >
        <span className={`cov-flag cov-flag-${item.kind}`}>
          {item.kind === 'gap' ? '缺口' : '重叠'}
        </span>
        <span className="cov-body">
          <span className="cov-quote">
            {quote || <span className="ann-empty-quote">（空区间）</span>}
          </span>
          <span className="cov-meta">
            {item.start}–{item.end} · {length} 字
            {item.kind === 'overlap' && ` · ${item.annotationIds.length} 条标注叠加`}
          </span>
        </span>
      </button>
      {item.kind === 'overlap' && item.annotations.length > 0 && (
        <div className="cov-anns">
          {item.annotations.map((ca) => {
            const a = annById.get(ca.id)
            return (
              <div className="cov-ann-row" key={ca.id}>
                <button
                  type="button"
                  className="cov-ann-main"
                  title="在原文中定位该标注"
                  onClick={() => a && onFocusAnnotation(a)}
                >
                  <span className="ann-badge" style={{ backgroundColor: badgeColor(ca.id) }} />
                  <span className="cov-ann-quote" title={ca.quote}>
                    {ca.quote || <span className="ann-empty-quote">（空引文）</span>}
                  </span>
                </button>
                {ca.tags.length > 0 && (
                  <span className="cov-ann-tags">
                    {ca.tags.map((t) => (
                      <span className="ann-tag" key={t}>
                        #{t}
                      </span>
                    ))}
                  </span>
                )}
                {a && (
                  <button
                    className="btn btn-small btn-ghost cov-ann-edit"
                    onClick={() => onEdit(a)}
                  >
                    编辑
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 标签覆盖审计侧栏分区 */
function CoverageSection(
  props: Pick<
    Props,
    | 'text'
    | 'annotations'
    | 'coverageTags'
    | 'coverageResult'
    | 'activeCoverageKey'
    | 'onChangeCoverageTags'
    | 'onFocusCoverage'
    | 'onFocus'
    | 'onEdit'
    | 'coverageSectionRef'
  >,
) {
  // 可选标签：当前标注中实际使用的全部标签（标签重命名后随之更新）
  const tagSet = new Set<string>()
  props.annotations.forEach((a) => a.tags.forEach((t) => tagSet.add(t)))
  const allAnnotationTags = [...tagSet]
  const selected = props.coverageTags
  const result = props.coverageResult
  const issueTotal = result.gapCount + result.overlapCount

  const toggle = (tag: string) => {
    props.onChangeCoverageTags(
      selected.includes(tag) ? selected.filter((t) => t !== tag) : [...selected, tag],
    )
  }

  const annById = new Map(props.annotations.map((a) => [a.id, a]))

  return (
    <section className="side-section" ref={(props.coverageSectionRef as React.Ref<HTMLElement>) ?? undefined}>
      <h2
        className={`side-heading ${issueTotal > 0 ? 'side-heading-coverage' : ''}`}
      >
        标签覆盖审计
        {issueTotal > 0 && (
          <span className="conflict-count-badge coverage-count-badge">{issueTotal}</span>
        )}
      </h2>
      <p className="side-hint">
        选择一组<strong>应共同覆盖全文</strong>的标签：仅统计已绑定且命中这些标签的标注，
        按 <code>[start,end)</code> 扫描全文——覆盖数为 0 记为<strong>缺口</strong>，
        大于 1 记为<strong>重叠</strong>；待处理标注与空区间忽略。
      </p>

      <div className="cov-tagpick">
        {allAnnotationTags.length === 0 ? (
          <p className="side-hint">还没有任何标签。先为标注添加标签后再来配置覆盖审计。</p>
        ) : (
          allAnnotationTags.map((t) => (
            <button
              type="button"
              key={t}
              className={`cov-tag ${selected.includes(t) ? 'cov-tag-on' : ''}`}
              aria-pressed={selected.includes(t)}
              onClick={() => toggle(t)}
              title={selected.includes(t) ? '点击移出覆盖标签集' : '点击加入覆盖标签集'}
            >
              #{t}
            </button>
          ))
        )}
      </div>

      {selected.length > 0 && (
        <>
          <div className="cov-summary">
            <span className="cov-summary-item cov-summary-gap">
              缺口 <strong>{result.gapCount}</strong> 处 · {result.gapLength} 字
            </span>
            <span className="cov-summary-item cov-summary-overlap">
              重叠 <strong>{result.overlapCount}</strong> 处
            </span>
            <span className="cov-summary-item">
              恰好覆盖一次 <strong>{result.coveredLength}</strong> 字
            </span>
          </div>
          <p className="side-hint">
            按起点排列；相邻且类型与参与标注集合相同的区间已合并。点击结果可在原文中定位并高亮。
          </p>
          {result.issues.length === 0 ? (
            <p className="cov-ok">✓ 所选标签恰好覆盖全文一次，没有缺口或重叠。</p>
          ) : (
            result.issues.map((item) => (
              <CoverageCard
                key={coverageIssueKey(item)}
                text={props.text}
                item={item}
                annById={annById}
                active={props.activeCoverageKey === coverageIssueKey(item)}
                onFocusIssue={props.onFocusCoverage}
                onFocusAnnotation={props.onFocus}
                onEdit={props.onEdit}
              />
            ))
          )}
        </>
      )}
    </section>
  )
}

export const Sidebar = forwardRef<HTMLElement, Props>(function Sidebar(props, sectionRef) {
  const pending = props.annotations
    .filter((a) => a.status === 'pending')
    .sort((x, y) => y.updatedAt - x.updatedAt)
  const bound = props.annotations
    .filter((a) => a.status === 'bound')
    .sort((x, y) => x.start - y.start)

  const activeConflicts = props.conflicts.filter((c) => !c.ignored)
  const ignoredConflicts = props.conflicts.filter((c) => c.ignored)
  const annById = new Map(props.annotations.map((a) => [a.id, a]))
  const pendingReportCount = props.annotations.filter((a) => a.status === 'pending').length
  const coverageIssueTotal =
    props.coverageResult.gapCount + props.coverageResult.overlapCount
  const activeRelationCount = props.relationViews.filter((v) => v.active).length
  const invalidRelationReportCount = props.relationViews.length - activeRelationCount
  const relationOverCount = props.relationCardinality.length
  // 批量操作筛选用：仅当前标注中实际使用的标签（标签重命名 / 删除后随之更新）
  const annotationTagSet = new Set<string>()
  props.annotations.forEach((a) => a.tags.forEach((t) => annotationTagSet.add(t)))
  const allAnnotationTags = [...annotationTagSet]

  return (
    <aside className="sidebar">
      <section className="side-section">
        <h2 className="side-heading">审阅报告</h2>
        <p className="side-hint">
          按<strong>当前文档快照</strong>生成并下载一个自包含 HTML 报告：开头汇总
          <strong>标注总数 / 待处理 / 冲突 / 覆盖问题 / 有效关系 / 失效关系 / 基数违规</strong>，正文按原文位置渲染已绑定标注的
          <strong>高亮、引文、标签与备注</strong>，并列出全部待处理标注、冲突双方与有效 / 失效关系明细（违规关系注明源端 / 目标端超限）。
          报告在浏览器本地生成，<strong>不会修改本地数据</strong>，可离线打开与打印。
        </p>
        <ul className="report-summary">
          <li>
            标注 <strong>{props.annotations.length}</strong>
          </li>
          <li className={pendingReportCount > 0 ? 'report-summary-warn' : ''}>
            待处理 <strong>{pendingReportCount}</strong>
          </li>
          <li className={activeConflicts.length > 0 ? 'report-summary-warn' : ''}>
            冲突 <strong>{activeConflicts.length}</strong>
          </li>
          <li className={coverageIssueTotal > 0 ? 'report-summary-warn' : ''}>
            覆盖问题 <strong>{coverageIssueTotal}</strong>
          </li>
          <li>
            有效关系 <strong>{activeRelationCount}</strong>
          </li>
          <li className={invalidRelationReportCount > 0 ? 'report-summary-warn' : ''}>
            失效关系 <strong>{invalidRelationReportCount}</strong>
          </li>
          <li className={relationOverCount > 0 ? 'report-summary-warn' : ''}>
            基数违规 <strong>{relationOverCount}</strong>
          </li>
        </ul>
        <button
          type="button"
          className="btn btn-primary report-download-btn"
          onClick={props.onDownloadReport}
          disabled={!props.text}
          title="生成自包含 HTML 审阅报告并下载（文件名含文档标题与当天日期）"
        >
          生成并下载 HTML 报告
        </button>
        {!props.text && <p className="side-hint">粘贴原文后即可生成报告。</p>}
      </section>

      {pending.length > 0 && (
        <section className="side-section">
          <h2 className="side-heading side-heading-pending">
            待处理（{pending.length}）
          </h2>
          <p className="side-hint">这些标注无法安全地自动重定位，请在原文中重新选择片段完成绑定。</p>
          {pending.map((a) => (
            <AnnotationItem
              key={a.id}
              a={a}
              active={props.activeId === a.id}
              onFocus={props.onFocus}
              onEdit={props.onEdit}
              onRebindStart={props.onRebindStart}
              onDelete={props.onDelete}
            />
          ))}
        </section>
      )}

      <CoverageSection
        text={props.text}
        annotations={props.annotations}
        coverageTags={props.coverageTags}
        coverageResult={props.coverageResult}
        activeCoverageKey={props.activeCoverageKey}
        onChangeCoverageTags={props.onChangeCoverageTags}
        onFocusCoverage={props.onFocusCoverage}
        onFocus={props.onFocus}
        onEdit={props.onEdit}
        coverageSectionRef={props.coverageSectionRef}
      />

      <MissingQuoteSection
        text={props.text}
        annotations={props.annotations}
        templateId={props.quoteTemplateId}
        audit={props.quoteAudit}
        activeRange={props.activeQuoteRange}
        onChangeTemplate={props.onChangeQuoteTemplate}
        onBackfill={props.onBackfillQuotes}
        onFocusOccurrence={props.onFocusQuoteOccurrence}
        sectionRef={props.quoteSectionRef}
      />

      <SnapshotSection
        baseline={props.baseline}
        diffs={props.snapshotDiffs}
        reviewedKeys={props.reviewedKeys}
        activeId={props.activeId}
        onSaveBaseline={props.onSaveBaseline}
        onClearBaseline={props.onClearBaseline}
        onToggleReview={props.onToggleReview}
        onFocus={props.onFocus}
        sectionRef={props.snapshotSectionRef}
      />

      <SamplingSection
        config={props.sampleConfig}
        allTags={props.allTags}
        annotations={props.annotations}
        queue={props.sampleQueue}
        reviews={props.sampleReviews}
        activeId={props.activeId}
        onSaveConfig={props.onSaveSampleConfig}
        onClearConfig={props.onClearSampleConfig}
        onSetReview={props.onSetSampleReview}
        onFocus={props.onFocus}
        sectionRef={props.samplingSectionRef}
      />

      <DatasetSplitSection
        title={props.title}
        text={props.text}
        annotations={props.annotations}
        sectionRef={props.datasetSplitSectionRef}
      />

      <section className="side-section" ref={sectionRef as React.Ref<HTMLElement>}>
        <div className="side-heading-row">
          <h2 className={`side-heading ${activeConflicts.length > 0 ? 'side-heading-conflict' : ''}`}>
            冲突审阅
            {activeConflicts.length > 0 && <span className="conflict-count-badge">{activeConflicts.length}</span>}
          </h2>
          <button className="btn btn-small btn-ghost" onClick={props.onConfigureRules}>
            {props.conflictRules.length > 0 ? '配置规则' : '配置互斥对'}
          </button>
        </div>

        {props.conflictRules.length === 0 ? (
          <p className="side-hint">
            尚未配置互斥标签对。点击「配置互斥对」添加规则（如 正面 ⇄ 反面），
            之后区间交叠且标签命中同一互斥对的两条已绑定标注会列在这里。
          </p>
        ) : activeConflicts.length === 0 ? (
          <p className="side-hint">
            {props.conflicts.length === 0
              ? '当前没有冲突。只检测已绑定标注之间、区间至少 1 个字符交集且标签命中互斥对的情况。'
              : `全部 ${ignoredConflicts.length} 条冲突均已忽略；标签或规则变化后会自动重新出现。`}
          </p>
        ) : (
          <>
            <p className="side-hint">按交叠起点排序。可定位双方、直接编辑任一标注，或忽略该冲突。</p>
            {activeConflicts.map((c) => (
              <ConflictCard
                key={`${c.annotationIds[0]}/${c.annotationIds[1]}`}
                text={props.text}
                item={c}
                annById={annById}
                activeId={props.activeId}
                onFocus={props.onFocus}
                onEdit={props.onEdit}
                onFocusOverlap={props.onFocusOverlap}
                onIgnore={props.onIgnore}
                onUnignore={props.onUnignore}
              />
            ))}
          </>
        )}

        {ignoredConflicts.length > 0 && (
          <details className="conflict-ignored-fold">
            <summary>已忽略（{ignoredConflicts.length}）</summary>
            {ignoredConflicts.map((c) => (
              <ConflictCard
                key={`${c.annotationIds[0]}/${c.annotationIds[1]}`}
                text={props.text}
                item={c}
                annById={annById}
                activeId={props.activeId}
                onFocus={props.onFocus}
                onEdit={props.onEdit}
                onFocusOverlap={props.onFocusOverlap}
                onIgnore={props.onIgnore}
                onUnignore={props.onUnignore}
              />
            ))}
          </details>
        )}
      </section>

      <section className="side-section">
        <div className="side-heading-row">
          <h2 className="side-heading">标签管理（{props.tagCount}）</h2>
          <button
            className="btn btn-small btn-ghost"
            onClick={props.onRenameTags}
            disabled={props.tagCount === 0}
            title="批量重命名一个标签：同步更新标注、互斥规则与忽略记录"
          >
            标签重命名
          </button>
        </div>
        <p className="side-hint">
          重命名会精确替换所有标注与互斥规则中的标签；同一标注内的重名标签去重保序，
          重复互斥规则按创建时间合并，失效的忽略记录自动清理。
        </p>
      </section>

      <BulkSection
        annotations={props.annotations}
        allTags={allAnnotationTags}
        onFocus={props.onFocus}
        onRebindStart={props.onRebindStart}
        onApply={props.onBulkApply}
      />

      <RelationsSection
        annotations={props.annotations}
        views={props.relationViews}
        activeId={props.activeId}
        cardinality={props.relationCardinality}
        cardinalityRules={props.relationCardinalityRules}
        onSaveCardinalityRules={props.onSaveRelationCardinalityRules}
        onCreate={props.onCreateRelation}
        onDelete={props.onDeleteRelation}
        onFocus={props.onFocus}
        onRebindStart={props.onRebindStart}
        sectionRef={props.relationsSectionRef}
      />

      <section className="side-section">
        <h2 className="side-heading">
          标注列表（{bound.length}
          {pending.length > 0 ? ` / 共 ${props.annotations.length}` : ''}）
        </h2>
        {bound.length === 0 && pending.length === 0 && (
          <p className="side-hint">在左侧原文中拖选一段文字即可添加标注。同一区间可以保留任意多条标注。</p>
        )}
        {bound.map((a) => (
          <AnnotationItem
            key={a.id}
            a={a}
            active={props.activeId === a.id}
            onFocus={props.onFocus}
            onEdit={props.onEdit}
            onRebindStart={props.onRebindStart}
            onDelete={props.onDelete}
          />
        ))}
      </section>
    </aside>
  )
})