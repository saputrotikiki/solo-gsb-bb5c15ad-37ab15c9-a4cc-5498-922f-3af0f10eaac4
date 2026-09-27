import { useState } from 'react'
import type { RefObject } from 'react'
import type { Annotation, AnnotationBaseline } from '../types'
import type { SnapshotDiffItem, SnapshotDiffKind } from '../lib/snapshot'
import { DIFF_KIND_LABEL, rangeLabel } from '../lib/snapshot'
import { badgeColor } from '../lib/segments'

interface Props {
  baseline: AnnotationBaseline | null
  diffs: SnapshotDiffItem[]
  /** 当前已审记录键集合（标注 ID + 差异内容签名） */
  reviewedKeys: Set<string>
  activeId: string | null
  onSaveBaseline: () => void
  onClearBaseline: () => void
  onToggleReview: (item: SnapshotDiffItem) => void
  onFocus: (a: Annotation) => void
  /** 快照对比分区的滚动定位 ref（顶栏按钮用） */
  sectionRef?: RefObject<HTMLElement | null>
}

type Filter = 'all' | SnapshotDiffKind

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'added', label: '新增' },
  { key: 'removed', label: '删除' },
  { key: 'modified', label: '修改' },
]

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 单条差异卡片：新增 / 删除 / 修改 */
function DiffCard({
  item,
  reviewed,
  active,
  onToggleReview,
  onFocus,
}: {
  item: SnapshotDiffItem
  reviewed: boolean
  active: boolean
  onToggleReview: (item: SnapshotDiffItem) => void
  onFocus: (a: Annotation) => void
}) {
  const current = item.current
  // 当前仍已绑定的项可定位；删除项展示基线引文
  const locatable = !!current && current.status === 'bound'
  const quote = current ? current.quote : (item.base?.quote ?? '')
  const meta = current ?? item.base

  return (
    <div
      className={`snap-item snap-${item.kind} ${reviewed ? 'snap-reviewed' : ''} ${active ? 'snap-active' : ''}`}
    >
      <div className="snap-head">
        <span className={`snap-flag snap-flag-${item.kind}`}>
          {DIFF_KIND_LABEL[item.kind]}
        </span>
        <span
          className="ann-badge"
          style={{ backgroundColor: badgeColor(item.annotationId) }}
        />
        <button
          type="button"
          className="snap-quote"
          disabled={!locatable}
          title={locatable ? '在原文中定位' : item.kind === 'removed' ? '基线引文（当前已删除）' : '当前未绑定区间'}
          onClick={() => locatable && current && onFocus(current)}
        >
          {quote || <span className="ann-empty-quote">（空引文）</span>}
        </button>
      </div>

      {item.kind === 'modified' && (
        <div className="snap-changes">
          {item.changes.map((c) => (
            <div className="snap-change" key={c.field}>
              <span className="snap-change-label">{c.label}</span>
              <span className="snap-change-values">
                <span className="snap-before">{c.before}</span>
                <span className="snap-arrow">→</span>
                <span className="snap-after">{c.after}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      {item.kind !== 'modified' && meta && (
        <div className="snap-meta">
          <span>{rangeLabel(meta.status, meta.start, meta.end)}</span>
          {meta.tags.length > 0 && (
            <span className="ann-tags snap-meta-tags">
              {meta.tags.map((t) => (
                <span className="ann-tag" key={t}>
                  #{t}
                </span>
              ))}
            </span>
          )}
          {meta.note && <span className="snap-meta-note">{meta.note}</span>}
        </div>
      )}

      <div className="snap-actions">
        {locatable && current && (
          <button className="btn btn-small btn-ghost" onClick={() => onFocus(current)}>
            定位
          </button>
        )}
        <span className="form-spacer" />
        <button
          className={`btn btn-small ${reviewed ? 'btn-ghost' : 'btn-primary'}`}
          onClick={() => onToggleReview(item)}
        >
          {reviewed ? '取消已审' : '标记已审'}
        </button>
      </div>
    </div>
  )
}

/** 快照对比侧栏分区：基线管理 + 差异列表（按原文位置排序、可按类型筛选） */
export function SnapshotSection(props: Props) {
  const { baseline, diffs, reviewedKeys } = props
  const [filter, setFilter] = useState<Filter>('all')

  const counts: Record<SnapshotDiffKind, number> = { added: 0, removed: 0, modified: 0 }
  diffs.forEach((d) => {
    counts[d.kind] += 1
  })
  const unreviewed = diffs.filter((d) => !reviewedKeys.has(d.key)).length
  const visible = filter === 'all' ? diffs : diffs.filter((d) => d.kind === filter)

  return (
    <section className="side-section" ref={(props.sectionRef as React.Ref<HTMLElement>) ?? undefined}>
      <h2 className={`side-heading ${unreviewed > 0 ? 'side-heading-snapshot' : ''}`}>
        快照对比
        {unreviewed > 0 && (
          <span className="conflict-count-badge snapshot-count-badge">{unreviewed}</span>
        )}
      </h2>

      {!baseline ? (
        <>
          <p className="side-hint">
            把当前标注集保存为<strong>唯一基线</strong>，之后随时对比：按标注 ID 归类
            新增 / 删除 / 修改，修改项逐字段列出前后值。
          </p>
          <button className="btn btn-small btn-primary" onClick={props.onSaveBaseline}>
            保存当前为基线
          </button>
        </>
      ) : (
        <>
          <p className="side-hint">
            基线建于 {formatTime(baseline.createdAt)} · {baseline.annotations.length} 条标注。
            差异按原文位置排序；已审以「标注 ID + 差异签名」记录，内容再变会重新出现。
          </p>
          <div className="snap-toolbar">
            <button
              className="btn btn-small btn-ghost"
              onClick={props.onSaveBaseline}
              title="以当前标注集重建基线，并清空全部已审记录"
            >
              重建基线
            </button>
            <button
              className="btn btn-small btn-ghost"
              onClick={props.onClearBaseline}
              title="删除基线与全部已审记录"
            >
              清除基线
            </button>
          </div>

          {diffs.length === 0 ? (
            <p className="cov-ok">✓ 当前标注与基线一致，没有差异。</p>
          ) : (
            <>
              <div className="snap-summary">
                <span>
                  新增 <strong>{counts.added}</strong>
                </span>
                <span>
                  删除 <strong>{counts.removed}</strong>
                </span>
                <span>
                  修改 <strong>{counts.modified}</strong>
                </span>
                <span>
                  待审 <strong>{unreviewed}</strong>
                </span>
              </div>
              <div className="snap-filters">
                {FILTERS.map((f) => (
                  <button
                    type="button"
                    key={f.key}
                    className={`snap-filter ${filter === f.key ? 'snap-filter-on' : ''}`}
                    aria-pressed={filter === f.key}
                    onClick={() => setFilter(f.key)}
                  >
                    {f.label} {f.key === 'all' ? diffs.length : counts[f.key]}
                  </button>
                ))}
              </div>
              {visible.length === 0 ? (
                <p className="side-hint">该类型下没有差异项。</p>
              ) : (
                visible.map((item) => (
                  <DiffCard
                    key={item.key}
                    item={item}
                    reviewed={reviewedKeys.has(item.key)}
                    active={props.activeId === item.annotationId}
                    onToggleReview={props.onToggleReview}
                    onFocus={props.onFocus}
                  />
                ))
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
