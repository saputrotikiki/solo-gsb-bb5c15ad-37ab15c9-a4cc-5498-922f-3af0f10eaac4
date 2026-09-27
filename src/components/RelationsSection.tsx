import { useEffect, useId, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { Annotation, RelationCardinalityRule } from '../types'
import { badgeColor } from '../lib/segments'
import {
  CARDINALITY_SIDE_LABEL,
  RELATION_INVALID_REASON_LABEL,
  cardinalityLimitText,
  isSelfRelation,
  makeCardinalityRuleId,
  normalizeRelationType,
  relationKey,
  relationTypeFilters,
  sortRelationViews,
  type CardinalityViolation,
  type RelationView,
} from '../lib/relations'

interface Props {
  annotations: Annotation[]
  views: RelationView[]
  activeId: string | null
  /** 基数上限审计结果（App 派生；无规则时 violations 为空） */
  cardinality: CardinalityViolation[]
  cardinalityRules: RelationCardinalityRule[]
  onSaveCardinalityRules: (rules: RelationCardinalityRule[]) => void
  onCreate: (sourceId: string, targetId: string, type: string) => void
  onDelete: (id: string) => void
  /** 点击有效关系的一端：在原文中定位（仅已绑定标注可调用） */
  onFocus: (a: Annotation) => void
  /** 点击失效关系上处于待处理的一端：进入重新绑定 */
  onRebindStart: (a: Annotation) => void
  /** 分区滚动定位 ref（顶栏按钮用） */
  sectionRef?: RefObject<HTMLElement | null>
}

const ALL_TYPES = '__all__'

/** 下拉选项文案：引文摘录 + 区间 + 标签，长引文截断 */
function optionLabel(a: Annotation): string {
  const quote = (a.quote || '（空引文）').replace(/\s+/g, ' ')
  const shown = quote.length > 24 ? `${quote.slice(0, 24)}…` : quote
  const tags = a.tags.length > 0 ? ` #${a.tags.join(' #')}` : ''
  return `[${a.start},${a.end}) ${shown}${tags}`
}

/** 关系一端：可点击定位 / 重新绑定；标注已删除时显示占位 */
function RelationEnd({
  role,
  view,
  side,
  activeId,
  onFocus,
  onRebindStart,
}: {
  role: '源' | '目标'
  view: RelationView
  side: 'source' | 'target'
  activeId: string | null
} & Pick<Props, 'onFocus' | 'onRebindStart'>) {
  const a = side === 'source' ? view.source : view.target
  if (!a) {
    return (
      <span className="rel-end rel-end-missing" title="该标注已被删除">
        <span className="rel-end-role">{role}</span>
        <span className="rel-end-quote">（标注已删除）</span>
      </span>
    )
  }
  if (a.status === 'pending') {
    return (
      <button
        type="button"
        className="rel-end rel-end-pending"
        title="该标注处于待处理，点击进入重新选择片段；绑定后关系自动恢复"
        onClick={() => onRebindStart(a)}
      >
        <span className="rel-end-role">{role}</span>
        <span className="ann-badge" style={{ backgroundColor: badgeColor(a.id) }} />
        <span className="rel-end-quote">
          <em className="ann-pending-flag">[待绑定] </em>
          {a.quote || <span className="ann-empty-quote">（空引文）</span>}
        </span>
      </button>
    )
  }
  return (
    <button
      type="button"
      className={`rel-end ${activeId === a.id ? 'rel-end-active' : ''}`}
      title="在原文中定位"
      onClick={() => onFocus(a)}
    >
      <span className="rel-end-role">{role}</span>
      <span className="ann-badge" style={{ backgroundColor: badgeColor(a.id) }} />
      <span className="rel-end-quote">{a.quote || <span className="ann-empty-quote">（空引文）</span>}</span>
      <span className="rel-end-pos">[{a.start},{a.end})</span>
    </button>
  )
}

function RelationCard({
  view,
  activeId,
  violation,
  onFocus,
  onRebindStart,
  onDelete,
}: {
  view: RelationView
  violation?: CardinalityViolation
} & Pick<Props, 'activeId' | 'onFocus' | 'onRebindStart' | 'onDelete'>) {
  return (
    <div
      className={`rel-item ${view.active ? '' : 'rel-item-invalid'} ${
        violation ? 'rel-item-over' : ''
      }`}
    >
      <div className="rel-ends">
        <RelationEnd
          role="源"
          view={view}
          side="source"
          activeId={activeId}
          onFocus={onFocus}
          onRebindStart={onRebindStart}
        />
        <div className="rel-arrow">
          <span className="rel-type-pill">{view.relation.type}</span>
          <span className="rel-arrow-mark">→</span>
        </div>
        <RelationEnd
          role="目标"
          view={view}
          side="target"
          activeId={activeId}
          onFocus={onFocus}
          onRebindStart={onRebindStart}
        />
      </div>
      {violation && (
        <p className="rel-over-reason" title={cardinalityLimitText(violation)}>
          <span className={`rel-over-flag rel-over-${violation.side}`}>
            {CARDINALITY_SIDE_LABEL[violation.side]}
          </span>
          {cardinalityLimitText(violation)}
        </p>
      )}
      {!view.active && view.invalidReason && (
        <p className="rel-invalid-reason">
          已失效：{RELATION_INVALID_REASON_LABEL[view.invalidReason]}
          {view.invalidReason.endsWith('pending') ? '；重新绑定后自动恢复' : ''}
        </p>
      )}
      <div className="rel-item-actions">
        <span className="form-spacer" />
        <button
          type="button"
          className="btn btn-small btn-ghost btn-danger-text"
          onClick={() => {
            if (confirm('确定删除这条关系吗？（不会删除两端标注）')) onDelete(view.relation.id)
          }}
        >
          删除关系
        </button>
      </div>
    </div>
  )
}

/** 新建关系表单：选择源 / 目标（仅已绑定标注）+ 填写关系类型，禁止自关联与完全重复 */
function RelationCreateForm({
  boundAnnotations,
  existingKeys,
  existingTypes,
  onCreate,
}: {
  boundAnnotations: Annotation[]
  existingKeys: Set<string>
  existingTypes: string[]
  onCreate: Props['onCreate']
}) {
  const listId = useId()
  const [sourceId, setSourceId] = useState('')
  const [targetId, setTargetId] = useState('')
  const [type, setType] = useState('')

  const cleanType = normalizeRelationType(type)
  const self = isSelfRelation(sourceId, targetId)
  const duplicate =
    !!sourceId && !!targetId && !!cleanType && !self
      ? existingKeys.has(relationKey(sourceId, targetId, cleanType))
      : false
  const canSubmit = !!sourceId && !!targetId && !!cleanType && !self && !duplicate

  const submit = () => {
    if (!canSubmit) return
    onCreate(sourceId, targetId, cleanType)
    setSourceId('')
    setTargetId('')
    setType('')
  }

  if (boundAnnotations.length < 2) {
    return (
      <p className="side-hint">
        至少需要 <strong>2 条已绑定标注</strong>才能建立关系。先在原文中拖选添加标注；
        待处理标注重新绑定后即可作为关系端点。
      </p>
    )
  }

  return (
    <div className="rel-create">
      <div className="rel-create-row">
        <select
          className="rule-input rel-select"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
        >
          <option value="">选择源标注…</option>
          {boundAnnotations.map((a) => (
            <option key={a.id} value={a.id}>
              {optionLabel(a)}
            </option>
          ))}
        </select>
      </div>
      <div className="rel-create-row rel-create-mid">
        <input
          className="rule-input rel-type-input"
          value={type}
          list={listId}
          placeholder="关系类型，如：支撑 / 反驳 / 引用 / 属于"
          onChange={(e) => setType(e.target.value)}
        />
        <span className="rel-create-arrow" title="有向">
          →
        </span>
        <select
          className="rule-input rel-select"
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
        >
          <option value="">选择目标标注…</option>
          {boundAnnotations.map((a) => (
            <option key={a.id} value={a.id}>
              {optionLabel(a)}
            </option>
          ))}
        </select>
      </div>
      <datalist id={listId}>
        {existingTypes.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {(self || duplicate) && (
        <p className="rel-create-msg">
          {self ? '源标注与目标标注不能是同一条标注（禁止自关联）。' : '已存在完全相同的关系（源、目标、类型一致），请勿重复建立。'}
        </p>
      )}
      <div className="rel-create-actions">
        <span className="form-spacer" />
        <button type="button" className="btn btn-small btn-primary" disabled={!canSubmit} onClick={submit}>
          建立关系
        </button>
      </div>
    </div>
  )
}

// ---------- 基数上限规则编辑 ----------

interface DraftRule {
  key: string // 行的稳定标识（已保存行为规则 id，新行为临时 id）
  id: string | null // null = 尚未保存的新行
  type: string
  maxOut: string // 文本框原值；空串表示不限
  maxIn: string
}

let draftSeq = 0
function newDraftKey(): string {
  draftSeq += 1
  return `draft_${Date.now().toString(36)}_${draftSeq}`
}

function ruleToDraft(r: RelationCardinalityRule): DraftRule {
  return { key: r.id, id: r.id, type: r.type, maxOut: r.maxOut === null ? '' : String(r.maxOut), maxIn: r.maxIn === null ? '' : String(r.maxIn) }
}

function parseLimitInput(raw: string): number | null | false {
  const v = raw.trim()
  if (v === '') return null
  if (!/^\d+$/.test(v)) return false
  const n = Number(v)
  return n >= 1 ? n : false
}

/**
 * 基数上限规则编辑器：每行一个关系类型 + 每源最大出边 / 每目标最大入边（留空不限）。
 * 编辑只改本地草稿；点「保存基数规则」才写入文档，保存后审计实时重算。
 */
function CardinalityEditor({
  rules,
  existingTypes,
  onSave,
}: {
  rules: RelationCardinalityRule[]
  existingTypes: string[]
  onSave: Props['onSaveCardinalityRules']
}) {
  const [drafts, setDrafts] = useState<DraftRule[]>(() => rules.map(ruleToDraft))
  const [error, setError] = useState('')

  // 外部规则变化（导入 / 其它入口）时同步草稿
  useEffect(() => {
    setDrafts(rules.map(ruleToDraft))
  }, [rules])

  const patch = (key: string, p: Partial<DraftRule>) => {
    setError('')
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...p } : d)))
  }

  const addRow = () => {
    setError('')
    const key = newDraftKey()
    setDrafts((ds) => [...ds, { key, id: null, type: '', maxOut: '', maxIn: '' }])
  }

  const removeRow = (key: string) => {
    setError('')
    setDrafts((ds) => ds.filter((d) => d.key !== key))
  }

  const save = () => {
    const out: RelationCardinalityRule[] = []
    const seen = new Set<string>()
    const now = Date.now()
    const prevById = new Map(rules.map((r) => [r.id, r]))
    for (const d of drafts) {
      const type = normalizeRelationType(d.type)
      if (!type) {
        setError('存在未填写关系类型的行；请补全类型，或删除该行后再保存。')
        return
      }
      if (seen.has(type)) {
        setError(`关系类型「${type}」配置了多行；每种类型只能有一条基数规则。`)
        return
      }
      const maxOut = parseLimitInput(d.maxOut)
      const maxIn = parseLimitInput(d.maxIn)
      if (maxOut === false || maxIn === false) {
        setError(`「${type}」的名额必须是不小于 1 的整数（留空表示该方向不限）。`)
        return
      }
      if (maxOut === null && maxIn === null) {
        setError(`「${type}」的出边 / 入边名额不能同时留空；若不需限制请删除该行。`)
        return
      }
      seen.add(type)
      const prev = d.id ? prevById.get(d.id) : undefined
      out.push({
        id: d.id ?? makeCardinalityRuleId(),
        type,
        maxOut,
        maxIn,
        createdAt: prev?.createdAt ?? now,
      })
    }
    onSave(out)
    setDrafts(out.map(ruleToDraft))
    setError('')
  }

  const discard = () => {
    setDrafts(rules.map(ruleToDraft))
    setError('')
  }

  return (
    <details className="rel-cap-fold">
      <summary>
        基数上限审计{rules.length > 0 ? `（已配置 ${rules.length} 个类型）` : ''}
      </summary>
      <p className="side-hint">
        按关系类型配置<strong>每条源标注允许的最大出边数</strong>与<strong>每条目标标注允许的最大入边数</strong>，
        留空表示不限。仅统计<strong>有效关系</strong>；同一端点同一类型按创建时间、再按关系 ID 稳定排序，
        超出名额的关系列为<strong>违规</strong>（注明源端 / 目标端 / 两者）。审计只提示，<strong>不会阻止建立关系</strong>；
        关系增删、失效恢复或导入后自动重算。
      </p>
      <div className="rel-cap-table">
        <div className="rel-cap-row rel-cap-head">
          <span>关系类型</span>
          <span>每源最大出边</span>
          <span>每目标最大入边</span>
          <span />
        </div>
        {drafts.length === 0 && (
          <p className="side-hint rel-cap-empty">尚未配置任何类型；添加一行后填写名额并保存。</p>
        )}
        {drafts.map((d) => {
          const seenType =
            d.type.trim() !== '' &&
            drafts.some((x) => x.key !== d.key && normalizeRelationType(x.type) === normalizeRelationType(d.type))
          return (
            <div className="rel-cap-row" key={d.key}>
              <input
                className="rule-input rel-cap-type"
                list={`rel-cap-types-${d.key}`}
                value={d.type}
                placeholder="关系类型"
                onChange={(e) => patch(d.key, { type: e.target.value })}
              />
              <datalist id={`rel-cap-types-${d.key}`}>
                {existingTypes.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              <input
                className="rule-input rel-cap-num"
                type="number"
                min={1}
                step={1}
                value={d.maxOut}
                placeholder="不限"
                onChange={(e) => patch(d.key, { maxOut: e.target.value })}
              />
              <input
                className="rule-input rel-cap-num"
                type="number"
                min={1}
                step={1}
                value={d.maxIn}
                placeholder="不限"
                onChange={(e) => patch(d.key, { maxIn: e.target.value })}
              />
              <button
                type="button"
                className="btn btn-small btn-ghost btn-danger-text"
                onClick={() => removeRow(d.key)}
              >
                删除
              </button>
              {seenType && <p className="rel-cap-row-err">该类型出现了多行配置</p>}
            </div>
          )
        })}
      </div>
      {error && <p className="rel-cap-error">{error}</p>}
      <div className="rel-cap-actions">
        <button type="button" className="btn btn-small btn-ghost" onClick={addRow}>
          添加一行
        </button>
        <span className="form-spacer" />
        <button type="button" className="btn btn-small btn-ghost" onClick={discard}>
          还原改动
        </button>
        <button type="button" className="btn btn-small btn-primary" onClick={save}>
          保存基数规则
        </button>
      </div>
    </details>
  )
}

/** 标注关系侧栏分区：新建表单 + 基数审计 + 类型筛选 + 有效 / 失效关系列表 */
export function RelationsSection(props: Props) {
  const { annotations, views } = props
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPES)

  const boundAnnotations = useMemo(
    () =>
      annotations
        .filter((a) => a.status === 'bound')
        .sort(
          (x, y) =>
            x.start - y.start || x.end - y.end || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
        ),
    [annotations],
  )

  const types = useMemo(() => relationTypeFilters(views.map((v) => v.relation)), [views])
  const existingKeys = useMemo(
    () => new Set(views.map((v) => relationKey(v.relation.sourceId, v.relation.targetId, v.relation.type))),
    [views],
  )

  const sorted = useMemo(() => sortRelationViews(views), [views])
  const violationById = useMemo(
    () => new Map(props.cardinality.map((c) => [c.view.relation.id, c])),
    [props.cardinality],
  )
  const matches = (v: RelationView) => typeFilter === ALL_TYPES || v.relation.type === typeFilter
  const activeViews = sorted.filter((v) => v.active && matches(v))
  const invalidViews = sorted.filter((v) => !v.active && matches(v))
  const violationViews = props.cardinality.filter((c) => matches(c.view))

  // 每个类型的关系数（含失效），供筛选芯片展示
  const countByType = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of views) m.set(v.relation.type, (m.get(v.relation.type) ?? 0) + 1)
    return m
  }, [views])

  // 当前筛选被删除（最后一条该类型关系被删）时回到「全部」
  useEffect(() => {
    if (typeFilter !== ALL_TYPES && !types.includes(typeFilter)) {
      setTypeFilter(ALL_TYPES)
    }
  }, [typeFilter, types])

  return (
    <section
      className="side-section relations-section"
      ref={(props.sectionRef as React.Ref<HTMLElement>) ?? undefined}
    >
      <h2
        className={`side-heading ${
          invalidViews.length > 0 || violationViews.length > 0 ? 'side-heading-relation' : ''
        }`}
      >
        标注关系
        {invalidViews.length > 0 && (
          <span className="conflict-count-badge relation-count-badge" title="失效关系数">
            {invalidViews.length}
          </span>
        )}
        {violationViews.length > 0 && (
          <span className="conflict-count-badge relation-over-badge" title="基数上限违规关系数">
            {violationViews.length}
          </span>
        )}
      </h2>
      <p className="side-hint">
        从两条<strong>已绑定标注</strong>中选择<strong>源</strong>与<strong>目标</strong>并填写
        <strong>关系类型</strong>，建立有向关系（源 → 目标）。禁止自关联与完全重复关系；
        点击关系任一端可定位原文。删除标注或其进入待处理时关系自动标为<strong>失效</strong>，
        待处理端重新绑定后<strong>自动恢复</strong>。
      </p>

      <RelationCreateForm
        boundAnnotations={boundAnnotations}
        existingKeys={existingKeys}
        existingTypes={types}
        onCreate={props.onCreate}
      />

      <CardinalityEditor
        rules={props.cardinalityRules}
        existingTypes={types}
        onSave={props.onSaveCardinalityRules}
      />

      {views.length === 0 ? (
        <p className="side-hint">还没有关系。</p>
      ) : (
        <>
          <div className="rel-filters">
            <button
              type="button"
              className={`rel-filter ${typeFilter === ALL_TYPES ? 'rel-filter-on' : ''}`}
              aria-pressed={typeFilter === ALL_TYPES}
              onClick={() => setTypeFilter(ALL_TYPES)}
            >
              全部 {views.length}
            </button>
            {types.map((t) => (
              <button
                type="button"
                key={t}
                className={`rel-filter ${typeFilter === t ? 'rel-filter-on' : ''}`}
                aria-pressed={typeFilter === t}
                onClick={() => setTypeFilter(t)}
                title="只显示该类型的关系"
              >
                {t} {countByType.get(t) ?? 0}
              </button>
            ))}
          </div>

          <p className="rel-summary">
            有效 <strong>{views.filter((v) => v.active).length}</strong> 条 · 失效{' '}
            <strong className={invalidViews.length > 0 ? 'rel-summary-invalid' : ''}>
              {invalidViews.length}
            </strong>{' '}
            条
            {props.cardinality.length > 0 && (
              <>
                {' '}· 基数违规{' '}
                <strong className={violationViews.length > 0 ? 'rel-summary-over' : ''}>
                  {violationViews.length}
                </strong>{' '}
                条
              </>
            )}
          </p>

          {violationViews.length > 0 && (
            <div className="rel-over-list">
              <p className="rel-over-title">
                基数上限违规（{violationViews.length}）
                <span className="rel-over-hint">按创建时间、再按关系 ID 稳定判定；点击任一端定位原文</span>
              </p>
              {violationViews.map((c) => (
                <RelationCard
                  key={`over-${c.view.relation.id}`}
                  view={c.view}
                  violation={c}
                  activeId={props.activeId}
                  onFocus={props.onFocus}
                  onRebindStart={props.onRebindStart}
                  onDelete={props.onDelete}
                />
              ))}
            </div>
          )}

          {activeViews.length === 0 ? (
            <p className="side-hint">该筛选下没有有效关系。</p>
          ) : (
            activeViews.map((v) => (
              <RelationCard
                key={v.relation.id}
                view={v}
                violation={violationById.get(v.relation.id)}
                activeId={props.activeId}
                onFocus={props.onFocus}
                onRebindStart={props.onRebindStart}
                onDelete={props.onDelete}
              />
            ))
          )}

          {invalidViews.length > 0 && (
            <details className="rel-invalid-fold">
              <summary>失效关系（{invalidViews.length}）</summary>
              {invalidViews.map((v) => (
                <RelationCard
                  key={v.relation.id}
                  view={v}
                  activeId={props.activeId}
                  onFocus={props.onFocus}
                  onRebindStart={props.onRebindStart}
                  onDelete={props.onDelete}
                />
              ))}
            </details>
          )}
        </>
      )}
    </section>
  )
}
