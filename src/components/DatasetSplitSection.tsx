import { useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { Annotation } from '../types'
import {
  buildDatasetJsonl,
  DATASET_LABELS,
  DATASET_NAMES,
  formatPercent,
  parsePercents,
  splitDatasets,
  type DatasetName,
  type DatasetSplitResult,
  type SplitPercents,
} from '../lib/datasetSplit'
import { badgeColor } from '../lib/segments'

interface Props {
  title: string
  text: string
  annotations: Annotation[]
  /** 训练集划分分区的滚动定位 ref（顶栏按钮用） */
  sectionRef?: RefObject<HTMLElement | null>
}

/** 生成一个随机种子（不要求密码学强度，仅用于划分分散） */
function randomSeed(): string {
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    const buf = new Uint32Array(2)
    crypto.getRandomValues(buf)
    return `${Date.now().toString(36)}-${buf[0].toString(36)}${buf[1].toString(36)}`
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function safeFilePart(title: string): string {
  return title.replace(/[\\/:*?"<>|\s]+/g, '_') || '未命名文档'
}

/** 触发浏览器下载（JSONL） */
function downloadJsonl(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/x-jsonlines;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** 百分比输入行 */
function PercentInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="split-percent-row">
      <span className="split-percent-label">{label}</span>
      <input
        className="rule-input split-percent-input"
        type="number"
        min={0}
        max={100}
        step={1}
        value={value}
        placeholder="0"
        onChange={(e) => onChange(e.target.value)}
      />
      <span className="split-percent-sign">%</span>
    </label>
  )
}

/** 一个集合的统计卡片 + JSONL 下载 */
function DatasetStatCard({
  name,
  result,
  title,
  text,
  datePart,
}: {
  name: DatasetName
  result: DatasetSplitResult
  title: string
  text: string
  datePart: string
}) {
  const stat = result.stats[name]
  const jsonl = useMemo(
    () => buildDatasetJsonl(result, title, text, name),
    [result, title, text, name],
  )
  const rows = stat.groupCount

  return (
    <div className="split-stat-card">
      <div className="split-stat-head">
        <span className={`split-stat-name split-stat-name-${name}`}>{stat.label}</span>
        <code className="split-stat-key">{name}</code>
      </div>
      <div className="split-stat-nums">
        <span>
          组数 <strong>{stat.groupCount}</strong>
        </span>
        <span>
          标注 <strong>{stat.annotationCount}</strong>
        </span>
        <span>
          目标 {stat.percent}% · 实际{' '}
          <strong>{formatPercent(stat.annotationPercent)}%</strong>
          <em className="split-stat-sub">（按组数 {formatPercent(stat.groupPercent)}%）</em>
        </span>
      </div>
      <button
        type="button"
        className="btn btn-small btn-primary split-download-btn"
        disabled={rows === 0}
        title={rows === 0 ? '该集合当前没有任何组' : `下载 ${name}.jsonl（${rows} 行）`}
        onClick={() =>
          downloadJsonl(
            `训练划分_${safeFilePart(title)}_${name}_${datePart}.jsonl`,
            jsonl,
          )
        }
      >
        下载 {name}.jsonl{rows > 0 ? `（${rows} 行）` : '（空）'}
      </button>
    </div>
  )
}

/** 一组在明细列表中的折叠展示 */
function GroupDetail({
  result,
  name,
}: {
  result: DatasetSplitResult
  name: DatasetName
}) {
  const items = result.assigned.filter((x) => x.dataset === name)
  if (items.length === 0) return null
  return (
    <details className="split-group-fold">
      <summary>
        {DATASET_LABELS[name]}分组明细（{items.length} 组 /{' '}
        {result.stats[name].annotationCount} 条标注）
      </summary>
      {items.map((item, i) => (
        <div className="split-group-item" key={item.group.annotationIds.join('|')}>
          <div className="split-group-meta">
            <span className="sample-index">{i + 1}</span>
            <span>
              {item.group.annotations.length} 条标注 · [{item.group.start}, {item.group.end})
            </span>
          </div>
          {item.group.annotations.map((a) => (
            <div className="split-group-ann" key={a.id}>
              <span className="ann-badge" style={{ backgroundColor: badgeColor(a.id) }} />
              <span className="split-group-ann-id" title={a.id}>
                {a.id}
              </span>
              <span className="split-group-quote" title={a.quote}>
                {a.quote || <span className="ann-empty-quote">（空引文）</span>}
              </span>
              {a.tags.length > 0 && (
                <span className="split-group-tags">
                  {a.tags.map((t) => (
                    <span className="ann-tag" key={t}>
                      #{t}
                    </span>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </details>
  )
}

/** 训练集划分导出侧栏分区 */
export function DatasetSplitSection(props: Props) {
  const { title, text, annotations } = props

  const [seed, setSeed] = useState(() => randomSeed())
  const [percentsText, setPercentsText] = useState<Record<DatasetName, string>>({
    train: '80',
    validation: '10',
    test: '10',
  })
  const [applied, setApplied] = useState<{
    seed: string
    percents: SplitPercents
  } | null>(null)

  const boundCount = annotations.filter((a) => a.status === 'bound').length
  const pendingCount = annotations.length - boundCount

  const parsed = useMemo(
    () =>
      parsePercents({
        train: percentsText.train,
        validation: percentsText.validation,
        test: percentsText.test,
      }),
    [percentsText],
  )

  const seedOk = seed.trim().length > 0
  const canApply = parsed.ok && seedOk

  // 划分结果由「已应用」的种子与百分比 + 当前标注集确定性派生：
  // 标注变动后重新渲染即按相同输入重算，同输入必得同结果。
  const result = useMemo(
    () =>
      applied
        ? splitDatasets(annotations, applied.percents, applied.seed)
        : null,
    [applied, annotations],
  )

  const apply = () => {
    if (!canApply || !parsed.ok) return
    setApplied({ seed: seed.trim(), percents: parsed.percents })
  }

  const setPercent = (name: DatasetName, v: string) =>
    setPercentsText((p) => ({ ...p, [name]: v }))

  const datePart = new Date().toISOString().slice(0, 10)

  return (
    <section
      className="side-section"
      ref={(props.sectionRef as React.Ref<HTMLElement>) ?? undefined}
    >
      <h2 className="side-heading">训练集划分导出</h2>
      <p className="side-hint">
        仅使用<strong>已绑定</strong>标注：区间有<strong>字符交集</strong>的标注（含传递关系）
        归入同一<strong>连通组</strong>，整组只能进入同一个数据集，绝不拆分。各组按
        <code>SHA-256(种子 + 组内标注 ID 排序拼接)</code> 排序后，依次放入当前相对目标缺口最大的集合；
        相同输入结果稳定。待处理标注不参与划分、不导出。
      </p>

      <div className="split-config">
        <div className="split-percent-rows">
          <PercentInput
            label="训练集 train"
            value={percentsText.train}
            onChange={(v) => setPercent('train', v)}
          />
          <PercentInput
            label="验证集 validation"
            value={percentsText.validation}
            onChange={(v) => setPercent('validation', v)}
          />
          <PercentInput
            label="测试集 test"
            value={percentsText.test}
            onChange={(v) => setPercent('test', v)}
          />
        </div>
        {!parsed.ok && <p className="split-error">{parsed.error}</p>}

        <label className="form-label split-seed-label" htmlFor="split-seed">
          划分种子
        </label>
        <div className="sample-seed-row">
          <input
            id="split-seed"
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
        {!seedOk && <p className="split-error">请填写种子。</p>}

        <div className="sample-config-actions">
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={!canApply}
            onClick={apply}
          >
            {applied ? '重新计算划分' : '计算划分'}
          </button>
          {!canApply && (
            <span className="sample-config-hint">
              {!seedOk ? '请填写种子' : '百分比须为 0-100 的整数且合计 100'}
            </span>
          )}
        </div>
      </div>

      <p className="side-hint">
        当前共 <strong>{boundCount}</strong> 条已绑定标注可参与划分
        {pendingCount > 0 && (
          <>
            ，<strong className="split-excluded">{pendingCount}</strong> 条待处理标注被排除、不导出
          </>
        )}
        。
      </p>

      {boundCount === 0 && (
        <p className="side-hint">当前没有已绑定标注，完成绑定后再来划分导出。</p>
      )}

      {result && applied && (
        <>
          <p className="side-hint sample-config-meta">
            种子 <code>{applied.seed}</code> · 共 {result.totalGroups} 个连通组 /{' '}
            {result.totalAnnotations} 条已绑定标注
            {result.excludedPending > 0 && (
              <>
                {' '}
                · 排除待处理 <strong>{result.excludedPending}</strong> 条
              </>
            )}
          </p>

          <div className="split-stats">
            {DATASET_NAMES.map((name) => (
              <DatasetStatCard
                key={name}
                name={name}
                result={result}
                title={title}
                text={text}
                datePart={datePart}
              />
            ))}
          </div>

          {DATASET_NAMES.map((name) => (
            <GroupDetail key={name} result={result} name={name} />
          ))}
        </>
      )}
    </section>
  )
}
