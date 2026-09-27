import { useEffect, useMemo, useState } from 'react'
import type { Annotation } from '../types'
import { badgeColor } from '../lib/segments'
import {
  filterAnnotations,
  normalizeBulkTags,
  planBulkTags,
  type BulkStatusFilter,
  type BulkTagMatch,
  type BulkTagPlan,
} from '../lib/bulk'
import { TagEditor } from './TagEditor'

interface Props {
  annotations: Annotation[]
  /** 当前全部已用标签（用于筛选与添加建议） */
  allTags: string[]
  onFocus: (a: Annotation) => void
  onRebindStart: (a: Annotation) => void
  /**
   * 确认落地：以当前数据重算计划并在 App 侧一次性更新。
   * 返回真正发生标签变化的标注数；无变化时不修改数据。
   */
  onApply: (
    selectedIds: string[],
    mode: 'add' | 'remove',
    tags: string[],
  ) => number
}

type Stage = 'edit' | 'preview'
type Mode = 'add' | 'remove'

interface ResultMessage {
  kind: 'ok' | 'info'
  text: string
}

function TagFlow({ tags, added, removed }: { tags: string[]; added: Set<string>; removed: Set<string> }) {
  if (tags.length === 0) return <span className="bulk-empty">（无标签）</span>
  return (
    <>
      {tags.map((t, i) => {
        const cls = added.has(t)
          ? 'ann-tag bulk-tag-add'
          : removed.has(t)
            ? 'ann-tag bulk-tag-del'
            : 'ann-tag'
        return (
          <span className={cls} key={`${t}-${i}`}>
            #{t}
          </span>
        )
      })}
    </>
  )
}

/**
 * 批量操作侧栏分区：
 * 组合筛选（状态 + 标签全部/任一 + 引文关键词）→ 全选 / 反选 →
 * 添加 / 移除标签 → 逐条预览标签变化 → 确认后一次性更新。
 * 取消预览或无实际变化时不改动任何数据。
 */
export function BulkSection({ annotations, allTags, onFocus, onRebindStart, onApply }: Props) {
  const [status, setStatus] = useState<BulkStatusFilter>('all')
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [tagMatch, setTagMatch] = useState<BulkTagMatch>('all')
  const [keyword, setKeyword] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [mode, setMode] = useState<Mode>('add')
  const [actionTags, setActionTags] = useState<string[]>([])
  const [stage, setStage] = useState<Stage>('edit')
  const [message, setMessage] = useState<ResultMessage | null>(null)

  // 结果提示自动消失
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 8000)
    return () => clearTimeout(t)
  }, [message])

  const matched = useMemo(
    () => filterAnnotations(annotations, { status, tags: filterTags, tagMatch, keyword }),
    [annotations, status, filterTags, tagMatch, keyword],
  )
  const matchedIds = useMemo(() => new Set(matched.map((a) => a.id)), [matched])
  // 操作范围始终是「当前筛选结果中被勾选」的标注，数据变化（删除 / 导入）后自动收敛
  const effectiveIds = useMemo(
    () => selectedIds.filter((id) => matchedIds.has(id)),
    [selectedIds, matchedIds],
  )
  const effectiveSet = useMemo(() => new Set(effectiveIds), [effectiveIds])

  const normalizedActionTags = useMemo(() => normalizeBulkTags(actionTags), [actionTags])

  // 预览计划：始终基于最新 props 计算，确认时 App 会再以同一输入重算一次
  const plan: BulkTagPlan | null = useMemo(() => {
    if (stage !== 'preview' || normalizedActionTags.length === 0) return null
    return planBulkTags(annotations, effectiveIds, mode, normalizedActionTags)
  }, [stage, normalizedActionTags, annotations, effectiveIds, mode])

  const allMatchedSelected = matched.length > 0 && effectiveIds.length === matched.length

  const toggleFilterTag = (tag: string) => {
    setStage('edit')
    setFilterTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    )
  }

  const toggleOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  const selectAll = () => {
    if (allMatchedSelected) {
      // 取消全选：仅清掉当前匹配项的勾选
      setSelectedIds((prev) => prev.filter((id) => !matchedIds.has(id)))
    } else {
      setSelectedIds((prev) => [...new Set([...prev, ...matched.map((a) => a.id)])])
    }
  }

  const invertSelection = () => {
    setSelectedIds((prev) => {
      const prevSet = new Set(prev)
      const next = prev.filter((id) => !matchedIds.has(id))
      for (const a of matched) {
        if (!prevSet.has(a.id)) next.push(a.id)
      }
      return next
    })
  }

  const resetFilters = () => {
    setStatus('all')
    setFilterTags([])
    setTagMatch('all')
    setKeyword('')
    setStage('edit')
  }

  const openPreview = (nextMode: Mode) => {
    // 切换操作类型时清空上次输入，避免把「要添加」的标签误当成「要移除」
    if (nextMode !== mode) setActionTags([])
    setMode(nextMode)
    setStage('preview')
  }

  const cancelPreview = () => setStage('edit')

  const confirmApply = () => {
    if (!plan || plan.affectedCount === 0) return
    const affected = onApply(effectiveIds, plan.mode, plan.tags)
    setStage('edit')
    setActionTags([])
    setSelectedIds([])
    setMessage({
      kind: 'ok',
      text:
        affected > 0
          ? `已${plan.mode === 'add' ? '添加' : '移除'}标签，更新 ${affected} 条标注。`
          : '没有标注的标签发生变化，数据未改动。',
    })
  }

  // 移除模式的建议标签：优先列出选中标注实际持有的标签
  const removeSuggestions = useMemo(() => {
    const owned: string[] = []
    for (const a of annotations) {
      if (!effectiveSet.has(a.id)) continue
      for (const t of a.tags) if (!owned.includes(t)) owned.push(t)
    }
    for (const t of allTags) if (!owned.includes(t)) owned.push(t)
    return owned.filter((t) => !normalizedActionTags.includes(t))
  }, [annotations, effectiveSet, allTags, normalizedActionTags])

  const addSuggestions = useMemo(
    () => allTags.filter((t) => !normalizedActionTags.includes(t)),
    [allTags, normalizedActionTags],
  )

  const hasFilters =
    status !== 'all' || filterTags.length > 0 || keyword.trim() !== ''

  return (
    <section className="side-section bulk-section">
      <h2 className="side-heading side-heading-bulk">批量操作</h2>

      {annotations.length === 0 ? (
        <p className="side-hint">还没有标注。先在原文中拖选添加标注后，再进行批量标签操作。</p>
      ) : (
        <>
          <p className="side-hint">
            按<strong>状态、标签、引文关键词</strong>组合筛选标注，全选或反选后
            批量<strong>添加 / 移除标签</strong>；提交前可逐条预览，取消不会改动数据。
          </p>

          {message && (
            <p className={`bulk-message bulk-message-${message.kind}`}>{message.text}</p>
          )}

          {stage === 'edit' ? (
            <>
              {/* ---------- 筛选区 ---------- */}
              <div className="bulk-filter-block">
                <div className="bulk-filter-row" role="group" aria-label="按标注状态筛选">
                  <span className="bulk-filter-label">状态</span>
                  <div className="bulk-seg">
                    {(
                      [
                        ['all', '全部'],
                        ['bound', '已绑定'],
                        ['pending', '待处理'],
                      ] as Array<[BulkStatusFilter, string]>
                    ).map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        className={`bulk-seg-btn ${status === value ? 'bulk-seg-on' : ''}`}
                        aria-pressed={status === value}
                        onClick={() => {
                          setStatus(value)
                          setStage('edit')
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bulk-filter-row">
                  <div className="bulk-filter-label-row">
                    <span className="bulk-filter-label">标签</span>
                    {filterTags.length > 0 && (
                      <div className="bulk-seg bulk-seg-mini">
                        <button
                          type="button"
                          className={`bulk-seg-btn ${tagMatch === 'all' ? 'bulk-seg-on' : ''}`}
                          aria-pressed={tagMatch === 'all'}
                          onClick={() => setTagMatch('all')}
                          title="标注需同时包含所选全部标签"
                        >
                          全部命中
                        </button>
                        <button
                          type="button"
                          className={`bulk-seg-btn ${tagMatch === 'any' ? 'bulk-seg-on' : ''}`}
                          aria-pressed={tagMatch === 'any'}
                          onClick={() => setTagMatch('any')}
                          title="标注包含任一所选标签即可"
                        >
                          任一命中
                        </button>
                      </div>
                    )}
                  </div>
                  {allTags.length === 0 ? (
                    <p className="side-hint bulk-no-tag-hint">当前标注还没有任何标签。</p>
                  ) : (
                    <div className="cov-tagpick bulk-tagpick">
                      {allTags.map((t) => (
                        <button
                          type="button"
                          key={t}
                          className={`cov-tag ${filterTags.includes(t) ? 'cov-tag-on' : ''}`}
                          aria-pressed={filterTags.includes(t)}
                          onClick={() => toggleFilterTag(t)}
                        >
                          #{t}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bulk-filter-row">
                  <label className="bulk-filter-label" htmlFor="bulk-keyword">
                    引文关键词
                  </label>
                  <input
                    id="bulk-keyword"
                    className="rule-input bulk-keyword"
                    type="text"
                    value={keyword}
                    placeholder="在引文中检索（不区分大小写）"
                    onChange={(e) => {
                      setKeyword(e.target.value)
                      setStage('edit')
                    }}
                  />
                </div>

                {hasFilters && (
                  <button type="button" className="btn btn-small btn-ghost bulk-reset" onClick={resetFilters}>
                    清空筛选
                  </button>
                )}
              </div>

              {/* ---------- 匹配结果与选择 ---------- */}
              <div className="bulk-match-bar">
                <span className="bulk-match-count">
                  匹配 <strong>{matched.length}</strong> 条
                  {effectiveIds.length > 0 && <em> · 已选 {effectiveIds.length} 条</em>}
                </span>
                <span className="bulk-match-actions">
                  <button
                    type="button"
                    className="btn btn-small btn-ghost"
                    disabled={matched.length === 0}
                    onClick={selectAll}
                  >
                    {allMatchedSelected ? '取消全选' : '全选'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-ghost"
                    disabled={matched.length === 0}
                    onClick={invertSelection}
                  >
                    反选
                  </button>
                </span>
              </div>

              {matched.length === 0 ? (
                <p className="side-hint bulk-empty-hint">
                  没有匹配的标注{hasFilters ? '，请放宽筛选条件。' : '。'}
                </p>
              ) : (
                <ul className="bulk-list">
                  {matched.map((a) => {
                    const checked = effectiveSet.has(a.id)
                    return (
                      <li
                        key={a.id}
                        className={`bulk-item ${checked ? 'bulk-item-on' : ''} ${a.status === 'pending' ? 'ann-pending' : ''}`}
                      >
                        <label className="bulk-check">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleOne(a.id)}
                            aria-label={checked ? '取消选择该标注' : '选择该标注'}
                          />
                        </label>
                        <button
                          type="button"
                          className="bulk-item-main"
                          title={a.status === 'bound' ? '在原文中定位' : '为待处理标注重新选择片段'}
                          onClick={() => (a.status === 'bound' ? onFocus(a) : onRebindStart(a))}
                        >
                          <span className="ann-badge" style={{ backgroundColor: badgeColor(a.id) }} />
                          <span className="bulk-item-quote">
                            {a.status === 'pending' && <em className="ann-pending-flag">[待绑定] </em>}
                            {a.quote || <span className="ann-empty-quote">（空引文）</span>}
                          </span>
                        </button>
                        {a.tags.length > 0 && (
                          <div className="bulk-item-tags">
                            {a.tags.map((t) => (
                              <span className="ann-tag" key={t}>
                                #{t}
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}

              {/* ---------- 批量操作 ---------- */}
              <div className="bulk-actions">
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  disabled={effectiveIds.length === 0}
                  onClick={() => openPreview('add')}
                  title="为选中的标注追加标签（自动去重、保留原顺序）"
                >
                  添加标签
                </button>
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  disabled={effectiveIds.length === 0}
                  onClick={() => openPreview('remove')}
                  title="从选中的标注中移除标签（保留其余标签顺序）"
                >
                  移除标签
                </button>
                {effectiveIds.length === 0 && matched.length > 0 && (
                  <span className="side-hint bulk-action-hint">勾选标注后即可批量操作。</span>
                )}
              </div>
            </>
          ) : (
            /* ---------- 预览区 ---------- */
            <div className="bulk-preview">
              <div className="form-title">
                {mode === 'add' ? '批量添加标签' : '批量移除标签'}
                <span className="bulk-preview-count">
                  选中 {effectiveIds.length} 条
                  {plan && plan.affectedCount < effectiveIds.length &&
                    ` · ${effectiveIds.length - plan.affectedCount} 条无变化将跳过`}
                </span>
              </div>

              <label className="form-label">
                {mode === 'add' ? '要添加的标签' : '要移除的标签'}
              </label>
              <TagEditor
                tags={actionTags}
                onChange={setActionTags}
                suggestions={mode === 'add' ? addSuggestions : removeSuggestions}
                placeholder={mode === 'add' ? '输入要添加的标签后回车' : '输入要移除的标签后回车'}
              />

              {normalizedActionTags.length === 0 ? (
                <p className="rename-msg">请先填写至少一个标签。</p>
              ) : plan && plan.affectedCount === 0 ? (
                <p className="rename-msg rename-msg-bad">
                  {mode === 'add'
                    ? '选中的标注都已包含这些标签，没有需要更新的内容。'
                    : '选中的标注都不包含这些标签，没有需要更新的内容。'}
                </p>
              ) : plan ? (
                <>
                  <p className="side-hint bulk-preview-hint">
                    将更新 <strong>{plan.affectedCount}</strong> 条标注；原标签顺序保持、自动去重。
                  </p>
                  <ul className="bulk-preview-list">
                    {plan.changes.map((c) => {
                      const added = new Set(c.added)
                      const removed = new Set(c.removed)
                      return (
                        <li key={c.annotationId} className="rename-ann-row bulk-preview-row">
                          <div className="rename-ann-quote" title={c.quote}>
                            {c.status === 'pending' && <em className="ann-pending-flag">[待绑定] </em>}
                            {c.quote || <span className="ann-empty-quote">（空引文）</span>}
                          </div>
                          <div className="rename-tag-flow">
                            <span className="rename-tags bulk-preview-tags">
                              <TagFlow tags={c.before} added={added} removed={removed} />
                            </span>
                            <span className="rename-arrow">→</span>
                            <span className="rename-tags bulk-preview-tags">
                              <TagFlow tags={c.after} added={added} removed={removed} />
                            </span>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </>
              ) : null}

              <div className="form-actions">
                <span className="form-spacer" />
                <button type="button" className="btn btn-ghost" onClick={cancelPreview}>
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!plan || plan.affectedCount === 0}
                  onClick={confirmApply}
                >
                  确认更新{plan && plan.affectedCount > 0 ? `（${plan.affectedCount} 条）` : ''}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
