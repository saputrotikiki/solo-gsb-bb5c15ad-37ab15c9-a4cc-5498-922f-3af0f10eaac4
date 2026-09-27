import { useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type {
  Annotation,
  SampleConfig,
  SampleReview,
  SampleTarget,
  SampleVerdict,
} from '../types'
import type { SampleQueueEntry, SampleQueueResult } from '../lib/sampling'
import { annotationContentSignature, sampleReviewKey } from '../lib/sampling'
import { badgeColor } from '../lib/segments'

interface Props {
  config: SampleConfig | null
  /** 当前文档中使用过的全部标签（含配置中仍引用、但已无标注使用的标签） */
  allTags: string[]
  annotations: Annotation[]
  queue: SampleQueueResult
  reviews: SampleReview[]
  activeId: string | null
  onSaveConfig: (seed: string, targets: SampleTarget[]) => void
  onClearConfig: () => void
  /** 写入 / 覆盖一条结论（verdict 为 null 时清除该标注当前内容的结论） */
  onSetReview: (
    annotation: Annotation,
    verdict: SampleVerdict | null,
    note: string,
  ) => void
  onFocus: (a: Annotation) => void
  /** 抽样复核分区的滚动定位 ref（顶栏按钮用） */
  sectionRef?: RefObject<HTMLElement | null>
}

const VERDICT_LABEL: Record<SampleVerdict, string> = {
  pass: '通过',
  return: '退回',
}

function formatTimeSimple(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 生成一个随机种子（不要求密码学强度，仅用于抽样分散） */
function randomSeed(): string {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const buf = new Uint32Array(2)
    crypto.getRandomValues(buf)
    return `${Date.now().toString(36)}-${buf[0].toString(36)}${buf[1].toString(36)}`
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function configFingerprint(config: SampleConfig | null): string {
  return config
    ? `${config.seed}|${config.targets.map((t) => `${t.tag}:${t.count}`).join(',')}`
    : ''
}

/** 抽样配置表单：种子 + 每个标签的抽样数 */
function SampleConfigForm({
  config,
  allTags,
  candidateCountByTag,
  onSave,
  onClear,
}: {
  config: SampleConfig | null
  allTags: string[]
  /** 各标签当前可作为候选（已绑定且命中）的标注数，用于配额提示 */
  candidateCountByTag: Map<string, number>
  onSave: (seed: string, targets: SampleTarget[]) => void
  onClear: () => void
}) {
  // 未配置时预填一个随机种子，可直接改填抽样数生成（保存后以配置值为准）
  const [seed, setSeed] = useState(config?.seed ?? randomSeed())
  const [counts, setCounts] = useState<Record<string, string>>({})

  // 配置在外部被替换（保存 / 导入）后，用已保存值同步草稿
  useEffect(() => {
    setSeed(config?.seed ?? '')
    const next: Record<string, string> = {}
    for (const t of config?.targets ?? []) next[t.tag] = String(t.count)
    setCounts(next)
  }, [configFingerprint(config)])

  const tags = useMemo(() => {
    const set = new Set(allTags)
    for (const t of config?.targets ?? []) set.add(t.tag)
    return [...set].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
  }, [allTags, config])

  const parsedTargets = (): Array<{ tag: string; count: number }> =>
    tags
      .map((tag) => ({ tag, count: Math.floor(Number(counts[tag] ?? 0)) }))
      .filter((t) => Number.isFinite(t.count) && t.count > 0)

  const targets = parsedTargets()
  const canSubmit = seed.trim().length > 0 && targets.length > 0

  const submit = () => {
    if (!canSubmit) return
    onSave(
      seed,
      targets.map((t) => ({ tag: t.tag, count: t.count })),
    )
  }

  if (tags.length === 0) {
    return (
      <p className="side-hint">
        还没有任何标签。先为标注添加标签后再来配置抽样复核：系统只从<strong>已绑定</strong>
        且命中目标标签的标注中取样。
      </p>
    )
  }

  return (
    <div className="sample-config">
      <label className="form-label sample-seed-label" htmlFor="sample-seed">
        抽样种子
      </label>
      <div className="sample-seed-row">
        <input
          id="sample-seed"
          className="rule-input sample-seed-input"
          value={seed}
          placeholder="输入任意字符串作为种子"
          onChange={(e) => setSeed(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-small btn-ghost"
          title="随机生成一个种子"
          onClick={() => setSeed(randomSeed())}
        >
          随机
        </button>
      </div>
      <p className="side-hint">
        相同种子与配额、相同标注集必然得到<strong>相同队列</strong>；顺序由
        SHA-256(种子 + 标注 ID) 决定。
      </p>

      <div className="sample-tag-rows">
        {tags.map((tag) => {
          const candidates = candidateCountByTag.get(tag) ?? 0
          const value = counts[tag] ?? ''
          const n = Math.floor(Number(value))
          const over = value !== '' && Number.isFinite(n) && n > candidates
          return (
            <div className={`sample-tag-row ${over ? 'sample-tag-row-over' : ''}`} key={tag}>
              <span className="sample-tag-name">#{tag}</span>
              <input
                className="rule-input sample-count-input"
                type="number"
                min={0}
                step={1}
                value={value}
                placeholder="0"
                onChange={(e) => setCounts((c) => ({ ...c, [tag]: e.target.value }))}
              />
              <span className="sample-tag-pool">
                可抽 {candidates}
                {over && candidates > 0 && <em className="sample-over-flag"> · 超过可抽数</em>}
                {over && candidates === 0 && <em className="sample-over-flag"> · 无候选</em>}
              </span>
            </div>
          )
        })}
      </div>

      <div className="sample-config-actions">
        <button type="button" className="btn btn-small btn-primary" disabled={!canSubmit} onClick={submit}>
          {config ? '更新抽样配置' : '生成抽样队列'}
        </button>
        {config && (
          <button
            type="button"
            className="btn btn-small btn-ghost"
            onClick={() => {
              if (confirm('清除抽样配置？已有复核结论会保留在本地，之后使用相同配置时仍可命中。')) {
                onClear()
              }
            }}
          >
            清除配置
          </button>
        )}
        {!canSubmit && (
          <span className="sample-config-hint">
            {seed.trim().length === 0 ? '请填写种子' : '请至少为一个标签填写 ≥1 的抽样数'}
          </span>
        )}
      </div>
    </div>
  )
}

/** 单条抽中标注的复核卡片 */
function SampleCard({
  index,
  entry,
  annotation,
  review,
  active,
  draftNote,
  onDraftNote,
  onSetReview,
  onFocus,
}: {
  index: number
  entry: SampleQueueEntry
  annotation: Annotation
  review: SampleReview | null
  active: boolean
  draftNote: string
  onDraftNote: (note: string) => void
  onSetReview: (verdict: SampleVerdict | null, note: string) => void
  onFocus: (a: Annotation) => void
}) {
  const verdict = review?.verdict ?? null
  return (
    <div
      className={`sample-item ${verdict === 'pass' ? 'sample-pass' : ''} ${
        verdict === 'return' ? 'sample-return' : ''
      } ${active ? 'sample-active' : ''}`}
    >
      <div className="sample-head">
        <span className="sample-index">{index}</span>
        <span className="ann-badge" style={{ backgroundColor: badgeColor(annotation.id) }} />
        <button type="button" className="sample-quote" title="在原文中定位" onClick={() => onFocus(annotation)}>
          {annotation.quote || <span className="ann-empty-quote">（空引文）</span>}
        </button>
      </div>

      <div className="sample-tags-row">
        {annotation.tags.map((t) => (
          <span
            className={`ann-tag ${entry.coveredTags.includes(t) ? 'sample-tag-filled' : ''}`}
            key={t}
          >
            #{t}
          </span>
        ))}
        <span className="sample-meta">
          [{annotation.start}, {annotation.end})
          {review && (
            <span className="sample-reviewed-at">
              {' '}
              · {VERDICT_LABEL[review.verdict]}于 {formatTimeSimple(review.updatedAt)}
            </span>
          )}
        </span>
      </div>

      <textarea
        className="form-note sample-note"
        rows={2}
        placeholder="填写复核备注（可选）"
        value={draftNote}
        onChange={(e) => {
          onDraftNote(e.target.value)
          // 已有结论时备注即时并入结论
          if (review) onSetReview(review.verdict, e.target.value)
        }}
      />

      <div className="sample-actions">
        <button className="btn btn-small btn-ghost" onClick={() => onFocus(annotation)}>
          定位
        </button>
        <span className="form-spacer" />
        <button
          type="button"
          className={`btn btn-small ${verdict === 'return' ? 'btn-danger' : 'btn-ghost'}`}
          onClick={() => onSetReview(verdict === 'return' ? null : 'return', draftNote)}
          title="标记为退回"
        >
          退回
        </button>
        <button
          type="button"
          className={`btn btn-small ${verdict === 'pass' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onSetReview(verdict === 'pass' ? null : 'pass', draftNote)}
          title="标记为通过"
        >
          通过
        </button>
      </div>
    </div>
  )
}

/** 抽样复核侧栏分区：配置表单 + 标签配额统计 + 队列复核列表 */
export function SamplingSection(props: Props) {
  const { config, annotations, queue, reviews } = props

  const annById = useMemo(
    () => new Map(annotations.map((a) => [a.id, a])),
    [annotations],
  )

  // 已绑定且携带某标签的候选数（表单中的「可抽 N」）
  const candidateCountByTag = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of annotations) {
      if (a.status !== 'bound') continue
      const seen = new Set<string>()
      for (const t of a.tags) {
        if (seen.has(t)) continue
        seen.add(t)
        m.set(t, (m.get(t) ?? 0) + 1)
      }
    }
    return m
  }, [annotations])

  // 当前仍有效的结论（调用方已按内容签名修剪）；以「标注 ID + 当前签名」匹配
  const reviewByKey = useMemo(() => {
    const m = new Map<string, SampleReview>()
    for (const r of reviews) m.set(sampleReviewKey(r.annotationId, r.signature), r)
    return m
  }, [reviews])

  // 复核备注草稿，按「标注 ID + 当前内容签名」隔离：内容变化后草稿回到空
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const draftKey = (a: Annotation) => sampleReviewKey(a.id, annotationContentSignature(a))
  const getDraft = (a: Annotation): string => {
    const key = draftKey(a)
    if (key in drafts) return drafts[key]
    return reviewByKey.get(key)?.note ?? ''
  }
  const setDraft = (a: Annotation, note: string) => {
    setDrafts((d) => ({ ...d, [draftKey(a)]: note }))
  }

  const totalGap = queue.tagStats.reduce((n, t) => n + t.gap, 0)
  const reviewedCount = queue.entries.filter((e) => {
    const a = annById.get(e.annotationId)
    return a && reviewByKey.has(draftKey(a))
  }).length

  return (
    <section className="side-section" ref={(props.sectionRef as React.Ref<HTMLElement>) ?? undefined}>
      <h2
        className={`side-heading ${
          config && queue.entries.length > reviewedCount ? 'side-heading-sampling' : ''
        }`}
      >
        抽样复核
        {config && queue.entries.length > reviewedCount && (
          <span className="conflict-count-badge sampling-count-badge">
            {queue.entries.length - reviewedCount}
          </span>
        )}
      </h2>

      <SampleConfigForm
        config={config}
        allTags={props.allTags}
        candidateCountByTag={candidateCountByTag}
        onSave={props.onSaveConfig}
        onClear={props.onClearConfig}
      />

      {config && (
        <>
          <p className="side-hint sample-config-meta">
            种子 <code>{config.seed}</code> · 配置更新于 {formatTimeSimple(config.updatedAt)}
            <br />
            候选 {queue.candidateCount} 条 · 抽中 {queue.entries.length} 条 · 已复核 {reviewedCount} 条
          </p>

          {queue.tagStats.length > 0 && (
            <div className="sample-tag-stats">
              {queue.tagStats.map((s) => (
                <div className="sample-tag-stat" key={s.tag}>
                  <span className="sample-stat-tag">#{s.tag}</span>
                  <span className="sample-stat-nums">
                    目标 <strong>{s.target}</strong> · 实际{' '}
                    <strong className={s.gap > 0 ? 'sample-stat-gap-num' : ''}>{s.actual}</strong>
                    {s.gap > 0 ? (
                      <em className="sample-stat-gap"> · 缺口 {s.gap}</em>
                    ) : s.actual > s.target ? (
                      <em className="sample-stat-over"> · 超额 {s.actual - s.target}</em>
                    ) : (
                      <em className="sample-stat-ok"> · 已满额</em>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {totalGap > 0 && (
            <p className="sample-gap-hint">
              有 {totalGap} 个标签配额未补足：候选耗尽后无法继续取样，可降低配额或补充标注。
            </p>
          )}

          {queue.entries.length === 0 ? (
            <p className="side-hint">
              当前没有任何已绑定且命中目标标签的候选标注。为标注打上目标标签并完成绑定后，
              队列会自动更新。
            </p>
          ) : (
            queue.entries.map((entry, i) => {
              const a = annById.get(entry.annotationId)
              if (!a) return null
              const key = draftKey(a)
              const review = reviewByKey.get(key) ?? null
              return (
                <SampleCard
                  key={`${entry.round}:${entry.annotationId}`}
                  index={i + 1}
                  entry={entry}
                  annotation={a}
                  review={review}
                  active={props.activeId === a.id}
                  draftNote={getDraft(a)}
                  onDraftNote={(note) => setDraft(a, note)}
                  onSetReview={(verdict, note) => props.onSetReview(a, verdict, note)}
                  onFocus={props.onFocus}
                />
              )
            })
          )}
        </>
      )}
    </section>
  )
}
