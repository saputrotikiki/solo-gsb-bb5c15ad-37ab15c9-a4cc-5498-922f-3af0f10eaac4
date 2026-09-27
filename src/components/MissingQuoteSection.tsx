import { useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { Annotation } from '../types'
import type { QuoteAudit, QuoteOccurrence } from '../lib/missingQuotes'

interface Props {
  text: string
  annotations: Annotation[]
  /** 当前选中的模板标注 ID（App 侧状态；null 表示未选择） */
  templateId: string | null
  /** 当前模板的漏标审阅结果（App 派生；模板失效时为 null） */
  audit: QuoteAudit | null
  /** 侧栏点击漏标 / 已标注位置后高亮的区间 */
  activeRange: { start: number; end: number } | null
  onChangeTemplate: (id: string | null) => void
  /**
   * 确认批量补建：以最新文档重新核对勾选位置并一次性落地。
   * 返回实际补建条数与跳过条数（位置已变化或已被补过）。
   */
  onBackfill: (
    positions: Array<{ start: number; end: number }>,
  ) => { created: number; skipped: number }
  /** 点击某个出现位置：在原文中滚动定位并高亮 */
  onFocusOccurrence: (occ: { start: number; end: number }) => void
  /** 分区滚动定位 ref（顶栏按钮用） */
  sectionRef?: RefObject<HTMLElement | null>
}

/** 前后文摘录半径（字符数） */
const CTX_RADIUS = 12

interface Message {
  kind: 'ok' | 'info'
  text: string
}

function occKey(o: { start: number; end: number }): string {
  return `${o.start}:${o.end}`
}

/** 模板下拉选项文案：区间 + 引文摘录 + 标签，长引文截断 */
function templateLabel(a: Annotation): string {
  const quote = (a.quote || '（空引文）').replace(/\s+/g, ' ')
  const shown = quote.length > 24 ? `${quote.slice(0, 24)}…` : quote
  const tags = a.tags.length > 0 ? ` #${a.tags.join(' #')}` : ''
  return `[${a.start},${a.end}) ${shown}${tags}`
}

/** 出现位置的前后文摘录（空白归一为空格，截断处加省略号） */
function OccurrenceExcerpt({
  text,
  quote,
  occ,
}: {
  text: string
  quote: string
  occ: QuoteOccurrence
}) {
  const before = text
    .slice(Math.max(0, occ.start - CTX_RADIUS), occ.start)
    .replace(/\s+/g, ' ')
  const after = text
    .slice(occ.end, Math.min(text.length, occ.end + CTX_RADIUS))
    .replace(/\s+/g, ' ')
  return (
    <span className="mq-ctx">
      {occ.start > CTX_RADIUS && '…'}
      {before}
      <mark className="mq-quote">{quote}</mark>
      {after}
      {occ.end + CTX_RADIUS < text.length && '…'}
    </span>
  )
}

/**
 * 同引文漏标审阅侧栏分区：
 * 选择模板（已绑定标注）→ 枚举引文全部精确出现位置（含重叠）→
 * 起止完全相同的已绑定标注记为已标注 → 勾选调标位置批量补建（复制模板标签与备注）。
 * 列表与计数随原文、标注编辑或导入实时重算；勾选集随最新漏标列表自动收敛。
 */
export function MissingQuoteSection(props: Props) {
  const { audit } = props
  const [checked, setChecked] = useState<string[]>([])
  const [message, setMessage] = useState<Message | null>(null)

  // 结果提示自动消失
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(null), 8000)
    return () => clearTimeout(t)
  }, [message])

  // 可选模板：已绑定且引文非空的标注，按原文位置排列
  const templates = useMemo(
    () =>
      props.annotations
        .filter((a) => a.status === 'bound' && a.quote.length > 0)
        .sort((x, y) => x.start - y.start || x.end - y.end || x.id.localeCompare(y.id)),
    [props.annotations],
  )
  const template = audit
    ? (props.annotations.find((a) => a.id === audit.templateId) ?? null)
    : null

  const missing = useMemo(
    () => (audit ? audit.occurrences.filter((o) => !o.covered) : []),
    [audit],
  )
  const covered = useMemo(
    () => (audit ? audit.occurrences.filter((o) => o.covered) : []),
    [audit],
  )
  const missingKeys = useMemo(() => new Set(missing.map(occKey)), [missing])
  // 勾选集随最新漏标列表收敛：位置被补过或原文变化后自动失效
  const effectiveChecked = useMemo(
    () => checked.filter((k) => missingKeys.has(k)),
    [checked, missingKeys],
  )
  const effectiveSet = useMemo(() => new Set(effectiveChecked), [effectiveChecked])
  const missingByKey = useMemo(
    () => new Map(missing.map((o) => [occKey(o), o])),
    [missing],
  )

  const changeTemplate = (id: string | null) => {
    props.onChangeTemplate(id)
    setChecked([])
    setMessage(null)
  }

  const toggleOne = (key: string) => {
    setChecked((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    )
  }

  const allChecked = missing.length > 0 && effectiveChecked.length === missing.length
  const toggleAll = () => {
    setChecked(allChecked ? [] : missing.map(occKey))
  }

  const submit = () => {
    if (!audit || effectiveChecked.length === 0) return
    const positions = effectiveChecked
      .map((k) => missingByKey.get(k))
      .filter((o): o is QuoteOccurrence => !!o)
      .map((o) => ({ start: o.start, end: o.end }))
    if (positions.length === 0) return
    const result = props.onBackfill(positions)
    setChecked([])
    if (result.created > 0) {
      setMessage({
        kind: 'ok',
        text:
          `已补建 ${result.created} 条标注（复制模板标签与备注，并按各位置重新截取上下文）。` +
          (result.skipped > 0 ? `另有 ${result.skipped} 处位置已变化或已补过，自动跳过。` : ''),
      })
    } else {
      setMessage({
        kind: 'info',
        text: '没有补建任何标注：所选位置已变化或已被补过。',
      })
    }
  }

  return (
    <section
      className="side-section mq-section"
      ref={(props.sectionRef as React.Ref<HTMLElement>) ?? undefined}
    >
      <h2 className={`side-heading ${audit && audit.missingCount > 0 ? 'side-heading-mq' : ''}`}>
        同引文漏标审阅
        {audit && audit.missingCount > 0 && (
          <span className="conflict-count-badge mq-count-badge">{audit.missingCount}</span>
        )}
      </h2>
      <p className="side-hint">
        选一条<strong>已绑定标注</strong>作为模板：枚举其引文在全文中的<strong>全部精确出现位置</strong>
        （含重叠）；只有<strong>起止完全相同的已绑定标注</strong>算已标注（待处理不算）。
        勾选调标位置后批量补建：新标注复制模板标签与备注，并按各位置重新截取锚点上下文。
      </p>

      {templates.length === 0 ? (
        <p className="side-hint">还没有可作为模板的已绑定标注。先在原文中拖选添加标注。</p>
      ) : (
        <>
          <select
            className="rule-input mq-select"
            value={audit ? (props.templateId ?? '') : ''}
            onChange={(e) => changeTemplate(e.target.value || null)}
            aria-label="选择模板标注"
          >
            <option value="">选择一条已绑定标注作为模板…</option>
            {templates.map((a) => (
              <option key={a.id} value={a.id}>
                {templateLabel(a)}
              </option>
            ))}
          </select>

          {props.templateId && !audit && (
            <p className="mq-msg mq-msg-info">
              所选模板已失效（被删除或进入待处理），请重新选择。
            </p>
          )}

          {audit && template && (
            <>
              <div className="mq-summary">
                <span className="mq-summary-item">
                  共出现 <strong>{audit.occurrences.length}</strong> 处
                </span>
                <span className="mq-summary-item">
                  已标注 <strong>{audit.coveredCount}</strong> 处
                </span>
                <span
                  className={`mq-summary-item ${audit.missingCount > 0 ? 'mq-summary-missing' : ''}`}
                >
                  漏标 <strong>{audit.missingCount}</strong> 处
                </span>
              </div>

              <div className="mq-template">
                <span className="mq-template-label">将复制</span>
                {template.tags.length > 0 ? (
                  <span className="mq-template-tags">
                    {template.tags.map((t) => (
                      <span className="ann-tag" key={t}>
                        #{t}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="mq-template-none">（无标签）</span>
                )}
                <span className="mq-template-note" title={template.note}>
                  备注：{template.note || '（无）'}
                </span>
              </div>

              {message && <p className={`mq-msg mq-msg-${message.kind}`}>{message.text}</p>}

              {audit.occurrences.length === 0 ? (
                <p className="side-hint">
                  模板引文在当前原文中没有任何精确出现（原文与标注可能不一致）。
                </p>
              ) : missing.length === 0 ? (
                <p className="mq-ok">✓ 全部出现位置均已有起止完全相同的已绑定标注，没有漏标。</p>
              ) : (
                <>
                  <div className="mq-toolbar">
                    <span className="mq-toolbar-count">
                      漏标位置 <strong>{missing.length}</strong> 处
                      {effectiveChecked.length > 0 && <em> · 已选 {effectiveChecked.length}</em>}
                    </span>
                    <button type="button" className="btn btn-small btn-ghost" onClick={toggleAll}>
                      {allChecked ? '清空' : '全选'}
                    </button>
                  </div>
                  <ul className="mq-list">
                    {missing.map((occ) => {
                      const key = occKey(occ)
                      const index = audit.occurrences.indexOf(occ)
                      const active =
                        !!props.activeRange &&
                        props.activeRange.start === occ.start &&
                        props.activeRange.end === occ.end
                      return (
                        <li
                          key={key}
                          className={`mq-item ${effectiveSet.has(key) ? 'mq-item-on' : ''} ${active ? 'mq-item-active' : ''}`}
                        >
                          <label className="mq-check">
                            <input
                              type="checkbox"
                              checked={effectiveSet.has(key)}
                              onChange={() => toggleOne(key)}
                              aria-label={effectiveSet.has(key) ? '取消选择该位置' : '选择该位置'}
                            />
                          </label>
                          <button
                            type="button"
                            className="mq-item-main"
                            title="在原文中定位该位置"
                            onClick={() => props.onFocusOccurrence(occ)}
                          >
                            <OccurrenceExcerpt text={props.text} quote={audit.quote} occ={occ} />
                            <span className="mq-meta">
                              第 {index + 1} 处 · [{occ.start},{occ.end})
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                  <div className="mq-actions">
                    <button
                      type="button"
                      className="btn btn-small btn-primary"
                      disabled={effectiveChecked.length === 0}
                      onClick={submit}
                      title="为勾选位置批量补建标注：复制模板标签与备注，并按各位置重新截取上下文"
                    >
                      补建标注{effectiveChecked.length > 0 ? `（${effectiveChecked.length}）` : ''}
                    </button>
                    {effectiveChecked.length === 0 && (
                      <span className="side-hint mq-action-hint">勾选调标位置后即可补建。</span>
                    )}
                  </div>
                </>
              )}

              {covered.length > 0 && (
                <details className="mq-covered-fold">
                  <summary>已标注位置（{covered.length}）</summary>
                  <ul className="mq-list">
                    {covered.map((occ) => {
                      const index = audit.occurrences.indexOf(occ)
                      const active =
                        !!props.activeRange &&
                        props.activeRange.start === occ.start &&
                        props.activeRange.end === occ.end
                      return (
                        <li
                          key={occKey(occ)}
                          className={`mq-item mq-item-covered ${active ? 'mq-item-active' : ''}`}
                        >
                          <button
                            type="button"
                            className="mq-item-main"
                            title="在原文中定位该位置"
                            onClick={() => props.onFocusOccurrence(occ)}
                          >
                            <OccurrenceExcerpt text={props.text} quote={audit.quote} occ={occ} />
                            <span className="mq-meta">
                              第 {index + 1} 处 · [{occ.start},{occ.end})
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </details>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}
