import { useId, useMemo, useState } from 'react'
import { normalizeTag } from '../lib/conflicts'
import { planTagRename, type TagRenamePlan } from '../lib/rename'
import type { Annotation, ConflictRule, IgnoredConflict } from '../types'

interface Props {
  annotations: Annotation[]
  conflictRules: ConflictRule[]
  ignoredConflicts: IgnoredConflict[]
  coverageTags: string[]
  allTags: string[]
  onCancel: () => void
  onApply: (source: string, target: string) => void
}

/** 标签展示（# 前缀），空引文给占位 */
function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="rename-empty">（无标签）</span>
  return (
    <>
      {tags.map((t, i) => (
        <span className="ann-tag" key={`${t}-${i}`}>
          #{t}
        </span>
      ))}
    </>
  )
}

/**
 * 标签重命名弹层：选择源标签、填写目标标签后实时预览影响范围。
 * 预览仅基于当前 props 计算，取消时不产生任何状态变更；
 * 确认后由 App 以同一份输入重新计算并在一次状态更新中落地。
 */
export function TagRenameEditor({
  annotations,
  conflictRules,
  ignoredConflicts,
  coverageTags,
  allTags,
  onCancel,
  onApply,
}: Props) {
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const listId = useId()

  const normalizedTarget = normalizeTag(target)
  const plan: TagRenamePlan | null = useMemo(
    () =>
      source
        ? planTagRename(
            { annotations, conflictRules, ignoredConflicts, coverageTags },
            source,
            target,
          )
        : null,
    [source, target, annotations, conflictRules, ignoredConflicts, coverageTags],
  )

  const sameTag = normalizedTarget !== '' && normalizedTarget === source
  const canApply = !!plan

  const quoteOf = new Map(annotations.map((a) => [a.id, a]))

  return (
    <div className="tag-rename-editor">
      <div className="form-title">标签重命名</div>
      <p className="form-hint">
        选择一个<strong>源标签</strong>并填写<strong>目标标签</strong>。
        提交前可预览受影响的标注、互斥规则与忽略记录；确认后标签将被精确替换，
        规则同步更新，重复规则按创建时间合并，取消不会改动任何数据。
      </p>

      <div className="rename-fields">
        <label className="form-label" htmlFor={`${listId}-src`}>
          源标签（从当前标签中选择）
        </label>
        <select
          id={`${listId}-src`}
          className="rule-input rename-select"
          value={source}
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">— 请选择要重命名的标签 —</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>

        <label className="form-label" htmlFor={`${listId}-dst`}>
          目标标签（新名称）
        </label>
        <input
          id={`${listId}-dst`}
          className="rule-input"
          list={listId}
          value={target}
          placeholder="输入新标签名，回车可快速选择已有标签"
          onChange={(e) => setTarget(e.target.value)}
        />
        <datalist id={listId}>
          {allTags.filter((t) => t !== source).map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>

      {source && normalizedTarget === '' && (
        <p className="rename-msg">请填写目标标签名称。</p>
      )}
      {sameTag && (
        <p className="rename-msg rename-msg-bad">目标标签与源标签相同，无需重命名。</p>
      )}

      {plan && (
        <div className="rename-preview">
          <div className="rename-summary">
            <div className="rename-summary-item">
              <span className="rename-summary-num">{plan.annotationChanges.length}</span>
              <span className="rename-summary-label">受影响标注</span>
            </div>
            <div className="rename-summary-item">
              <span className="rename-summary-num">{plan.affectedRuleCount}</span>
              <span className="rename-summary-label">受影响规则</span>
            </div>
            <div className="rename-summary-item">
              <span className="rename-summary-num">
                {plan.mergedRuleCount + plan.deletedRuleCount}
              </span>
              <span className="rename-summary-label">
                将合并 {plan.mergedRuleCount} / 删除 {plan.deletedRuleCount}
              </span>
            </div>
            <div className="rename-summary-item">
              <span className="rename-summary-num">{plan.removedIgnoredCount}</span>
              <span className="rename-summary-label">将清理忽略记录</span>
            </div>
          </div>

          {allTags.includes(plan.target) && (
            <p className="rename-merge-hint">
              目标标签 #{plan.target} 已存在：本次将把两个标签<strong>合并</strong>，
              同一标注内重复出现时只保留靠前的一个。
            </p>
          )}

          {plan.annotationChanges.length > 0 && (
            <details className="rename-fold" open>
              <summary>受影响标注（{plan.annotationChanges.length}）</summary>
              <ul className="rename-list">
                {plan.annotationChanges.map((c) => {
                  const a = quoteOf.get(c.annotationId)
                  return (
                    <li key={c.annotationId} className="rename-ann-row">
                      <div className="rename-ann-quote" title={c.quote}>
                        {a?.status === 'pending' && <em className="ann-pending-flag">[待绑定] </em>}
                        {c.quote || <span className="ann-empty-quote">（空引文）</span>}
                        {c.removedDuplicates > 0 && (
                          <span className="rename-dedup-flag" title="目标标签已存在，重复项已去除">
                            去重 ×{c.removedDuplicates}
                          </span>
                        )}
                      </div>
                      <div className="rename-tag-flow">
                        <span className="rename-tags">
                          <TagList tags={c.before} />
                        </span>
                        <span className="rename-arrow">→</span>
                        <span className="rename-tags">
                          <TagList tags={c.after} />
                        </span>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </details>
          )}

          {plan.ruleChanges.length > 0 && (
            <details className="rename-fold" open>
              <summary>
                互斥规则变更（{plan.ruleChanges.length}
                {plan.mergedRuleCount + plan.deletedRuleCount > 0 &&
                  `：合并 ${plan.mergedRuleCount} · 删除 ${plan.deletedRuleCount}`}
                ）
              </summary>
              <ul className="rename-list">
                {plan.ruleChanges.map((c, i) => (
                  <li
                    key={`${c.rule.id}-${c.kind}-${i}`}
                    className={`rename-rule-row rename-rule-${c.kind}`}
                  >
                    {c.kind === 'deleted' ? (
                      <>
                        <span className="rename-rule-pair">
                          {c.rule.tagA} ⇄ {c.rule.tagB}
                        </span>
                        <span className="rename-rule-badge rename-badge-del">删除（自互斥）</span>
                      </>
                    ) : c.kind === 'merged' ? (
                      <>
                        <span className="rename-rule-pair">
                          {c.rule.tagA} ⇄ {c.rule.tagB}
                        </span>
                        <span className="rename-arrow">合并到 →</span>
                        <span className="rename-rule-pair">
                          {c.survivor!.tagA} ⇄ {c.survivor!.tagB}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="rename-rule-pair">
                          {c.rule.tagA} ⇄ {c.rule.tagB}
                        </span>
                        <span className="rename-arrow">→</span>
                        <span className="rename-rule-pair">
                          {c.survivor!.tagA} ⇄ {c.survivor!.tagB}
                        </span>
                        {(c.absorbedCount ?? 0) > 0 && (
                          <span className="rename-rule-badge rename-badge-merge">
                            吸收 {c.absorbedCount} 条重复
                          </span>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="rename-ignored-hint">
            忽略记录：保留 {plan.keptIgnoredCount} 条
            {plan.rewrittenIgnoredCount > 0 &&
              `（其中 ${plan.rewrittenIgnoredCount} 条的规则引用已随合并改写）`}
            ，清理 {plan.removedIgnoredCount} 条（已无法对应当前冲突签名）。
          </p>
        </div>
      )}

      <div className="form-actions">
        <span className="form-spacer" />
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canApply}
          onClick={() => canApply && onApply(plan.source, plan.target)}
        >
          确认重命名
        </button>
      </div>
    </div>
  )
}
