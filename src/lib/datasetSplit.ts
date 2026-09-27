// 训练集划分导出：连通分组、稳定排序与确定性配额分配
//
// 仅使用【已绑定】标注（待处理标注一律排除并计数）。两条标注区间只要有至少 1 个字符交集
// （半开区间 [start,end) 下 start < other.end && other.start < end）即归入同一连通组，
// 交集关系按传递闭包合并（A 连 B、B 连 C → A/B/C 同组）。任何一组都是不可拆分的整体，
// 只能完整进入 train / validation / test 中的一个集合。
//
// 稳定性：每组按 SHA-256(种子 + 组内标注 ID 排序后直接拼接) 生成十六进制摘要，全部组按
// 摘要字典序排列；随后依次把每个组放入「当前相对目标缺口」最大的集合。
// 集合 i 的相对目标缺口 = (目标百分比 - 当前组数占比 * 100) / 目标百分比，
// 比较时交叉相乘化为整数比较 nA*pB ? nB*pA（取 n/p 最小者），完全避开浮点误差；
// 缺口完全相同按 train、validation、test 的固定顺序决胜。
// 因此同一份标注集 + 相同种子与百分比必然得到同一份划分。

import type { Annotation } from '../types'
import { sha256Hex } from './sampling'

export type DatasetName = 'train' | 'validation' | 'test'

/** 集合固定顺序：同缺口时的决胜顺序，也是展示与导出的顺序 */
export const DATASET_NAMES: DatasetName[] = ['train', 'validation', 'test']

export const DATASET_LABELS: Record<DatasetName, string> = {
  train: '训练集',
  validation: '验证集',
  test: '测试集',
}

export interface SplitPercents {
  train: number
  validation: number
  test: number
}

/** 一个不可拆分的连通组 */
export interface SplitGroup {
  /** 组内全部标注 ID，字典序排列（同时用于哈希与导出） */
  annotationIds: string[]
  /** 组内标注，按区间起点、终点、ID 排序（便于展示与阅读导出文件） */
  annotations: Annotation[]
  /** 组覆盖的最小起点与最大终点（仅用于展示） */
  start: number
  end: number
  /** SHA-256(种子 + 组内标注 ID 排序后拼接) */
  hash: string
}

export interface AssignedGroup {
  group: SplitGroup
  dataset: DatasetName
}

export interface DatasetStat {
  name: DatasetName
  label: string
  /** 用户填写的目标百分比 */
  percent: number
  groupCount: number
  annotationCount: number
  /** 实际标注数占已绑定标注总数的百分比（0-100） */
  annotationPercent: number
  /** 实际组数占总组数的百分比（0-100） */
  groupPercent: number
}

export interface DatasetSplitResult {
  /** 划分结果，按组哈希字典序排列（同序用于导出） */
  assigned: AssignedGroup[]
  stats: Record<DatasetName, DatasetStat>
  totalGroups: number
  /** 参与划分的已绑定标注数 */
  totalAnnotations: number
  /** 被排除的待处理标注数（不参与划分、不导出） */
  excludedPending: number
}

// ---------- 百分比输入校验 ----------

export type ParsedPercents =
  | { ok: true; percents: SplitPercents }
  | { ok: false; error: string }

/**
 * 校验三个集合的百分比：必须是 0-100 的整数且合计恰好 100。
 * 入参为表单字符串（允许两端空白）。
 */
export function parsePercents(raw: {
  train: string
  validation: string
  test: string
}): ParsedPercents {
  const labels: Array<[DatasetName, string]> = [
    ['train', '训练集'],
    ['validation', '验证集'],
    ['test', '测试集'],
  ]
  const values: Record<DatasetName, number> = { train: 0, validation: 0, test: 0 }
  for (const [key, label] of labels) {
    const text = raw[key].trim()
    if (text === '') return { ok: false, error: `请填写${label}百分比。` }
    const n = Number(text)
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      return { ok: false, error: `${label}百分比必须是 0-100 的整数。` }
    }
    values[key] = n
  }
  const sum = values.train + values.validation + values.test
  if (sum !== 100) {
    return { ok: false, error: `三个集合百分比合计须为 100，当前为 ${sum}。` }
  }
  return { ok: true, percents: { ...values } }
}

// ---------- 连通分组（并查集 + 扫描线） ----------

/** 半开区间是否有至少 1 个字符交集；空区间（start === end）不与任何区间相交 */
function rangesOverlap(a: Annotation, b: Annotation): boolean {
  if (a.end <= a.start || b.end <= b.start) return false
  return a.start < b.end && b.start < a.end
}

function compareByPosition(a: Annotation, b: Annotation): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/**
 * 把已绑定标注按区间字符交集划分为连通组。
 * - 仅纳入 status === 'bound' 的标注（待处理由调用方计数排除）；
 * - 端点相接（[0,5) 与 [5,10)）无字符交集，不合并；
 * - 空区间标注无法与任何区间共享字符，各自成组；
 * - 纯函数，不修改传入数据。
 */
export function buildOverlapGroups(annotations: Annotation[]): Annotation[][] {
  const bound = annotations
    .filter((a) => a.status === 'bound')
    .sort(compareByPosition)

  // 并查集
  const parent = bound.map((_, i) => i)
  const find = (x: number): number => {
    let root = x
    while (parent[root] !== root) root = parent[root]
    while (parent[x] !== root) {
      const next = parent[x]
      parent[x] = root
      x = next
    }
    return root
  }
  const union = (x: number, y: number) => {
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent[Math.max(rx, ry)] = Math.min(rx, ry)
  }

  // 扫描线：active 为起点不晚于当前标注、且终点仍在当前起点之后的标注下标。
  // bound 已按起点排序，只需把新标注与所有仍存活的 active 标注做交集判断。
  const active: number[] = []
  for (let i = 0; i < bound.length; i++) {
    const cur = bound[i]
    for (let j = active.length - 1; j >= 0; j--) {
      if (bound[active[j]].end <= cur.start) {
        active.splice(j, 1)
      }
    }
    for (const idx of active) {
      if (rangesOverlap(bound[idx], cur)) union(idx, i)
    }
    active.push(i)
  }

  const byRoot = new Map<number, Annotation[]>()
  for (let i = 0; i < bound.length; i++) {
    const root = find(i)
    const list = byRoot.get(root)
    if (list) list.push(bound[i])
    else byRoot.set(root, [bound[i]])
  }
  for (const list of byRoot.values()) list.sort(compareByPosition)
  return [...byRoot.values()]
}

/** 组稳定顺序的哈希：SHA-256(种子 + 组内标注 ID 字典序拼接) */
export function groupHash(seed: string, annotationIds: string[]): string {
  return sha256Hex(seed + annotationIds.slice().sort().join(''))
}

// ---------- 划分 ----------

function emptyStats(percents: SplitPercents): Record<DatasetName, DatasetStat> {
  return {
    train: {
      name: 'train',
      label: DATASET_LABELS.train,
      percent: percents.train,
      groupCount: 0,
      annotationCount: 0,
      annotationPercent: 0,
      groupPercent: 0,
    },
    validation: {
      name: 'validation',
      label: DATASET_LABELS.validation,
      percent: percents.validation,
      groupCount: 0,
      annotationCount: 0,
      annotationPercent: 0,
      groupPercent: 0,
    },
    test: {
      name: 'test',
      label: DATASET_LABELS.test,
      percent: percents.test,
      groupCount: 0,
      annotationCount: 0,
      annotationPercent: 0,
      groupPercent: 0,
    },
  }
}

/**
 * 依据种子与百分比执行完整划分。
 * 组按哈希排序后依次分配给当前相对目标缺口最大的集合（p=0 的集合永不入选）；
 * 同缺口按 train、validation、test 决胜。
 */
export function splitDatasets(
  annotations: Annotation[],
  percents: SplitPercents,
  seed: string,
): DatasetSplitResult {
  const excludedPending = annotations.filter((a) => a.status !== 'bound').length

  const groups: SplitGroup[] = buildOverlapGroups(annotations).map((members) => {
    const annotationIds = members.map((a) => a.id).sort()
    return {
      annotationIds,
      annotations: members,
      start: members.reduce((m, a) => Math.min(m, a.start), Number.POSITIVE_INFINITY),
      end: members.reduce((m, a) => Math.max(m, a.end), Number.NEGATIVE_INFINITY),
      hash: groupHash(seed, annotationIds),
    }
  })
  // 哈希字典序；摘要极端碰撞时再以拼接 ID 决胜，保证全序确定
  groups.sort(
    (x, y) =>
      (x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0) ||
      (x.annotationIds.join('') < y.annotationIds.join('')
        ? -1
        : x.annotationIds.join('') > y.annotationIds.join('')
          ? 1
          : 0),
  )

  const groupCounts: Record<DatasetName, number> = {
    train: 0,
    validation: 0,
    test: 0,
  }
  const totalGroups = groups.length

  const assigned: AssignedGroup[] = groups.map((group) => {
    // 选 n/p 最小（相对目标缺口最大）的集合；只在目标百分比 > 0 的集合中选择。
    // nA/pA < nB/pB 等价于 nA*pB < nB*pA，全部为 0..100 的小整数，直接精确比较。
    let best: DatasetName | null = null
    for (const name of DATASET_NAMES) {
      const p = percents[name]
      if (p <= 0) continue
      if (best === null) {
        best = name
        continue
      }
      const lhs = groupCounts[name] * percents[best]
      const rhs = groupCounts[best] * percents[name]
      if (lhs < rhs) best = name
      // lhs === rhs 时保留先出现者：DATASET_NAMES 顺序即 train → validation → test
    }

    if (best === null) {
      // 三个百分比全为 0 不可能通过校验（合计须为 100）；兜底放空字符串会破坏类型，
      // 直接抛出说明配置非法。
      throw new Error('至少一个集合的目标百分比必须大于 0')
    }
    groupCounts[best] += 1
    return { group, dataset: best }
  })

  const stats = emptyStats(percents)
  const totalAnnotations = groups.reduce((n, g) => n + g.annotations.length, 0)
  for (const item of assigned) {
    const stat = stats[item.dataset]
    stat.groupCount += 1
    stat.annotationCount += item.group.annotations.length
  }
  for (const name of DATASET_NAMES) {
    const stat = stats[name]
    stat.annotationPercent =
      totalAnnotations > 0 ? (stat.annotationCount * 100) / totalAnnotations : 0
    stat.groupPercent = totalGroups > 0 ? (stat.groupCount * 100) / totalGroups : 0
  }

  return {
    assigned,
    stats,
    totalGroups,
    totalAnnotations,
    excludedPending,
  }
}

// ---------- JSONL 导出 ----------

export interface SplitJsonlAnnotation {
  id: string
  position: { start: number; end: number }
  quote: string
  tags: string[]
  note: string
}

export interface SplitJsonlRow {
  /** 文档标题 */
  title: string
  /** 文档原文 */
  text: string
  /** 集合名：train | validation | test */
  dataset: DatasetName
  /** 连通组：整组同属一个集合，绝不拆分 */
  group: {
    /** 组内标注 ID（字典序） */
    annotationIds: string[]
    /** 组内标注：区间、引文、标签、备注 */
    annotations: SplitJsonlAnnotation[]
  }
}

/**
 * 构造某个集合的 JSONL 文本：每个连通组一行（每行一个 JSON 对象），按组哈希顺序排列。
 * 空集合得到空字符串。
 */
export function buildDatasetJsonl(
  result: DatasetSplitResult,
  title: string,
  text: string,
  dataset: DatasetName,
): string {
  const lines: string[] = []
  for (const item of result.assigned) {
    if (item.dataset !== dataset) continue
    const row: SplitJsonlRow = {
      title,
      text,
      dataset,
      group: {
        annotationIds: [...item.group.annotationIds],
        annotations: item.group.annotations.map((a) => ({
          id: a.id,
          position: { start: a.start, end: a.end },
          quote: a.quote,
          tags: [...a.tags],
          note: a.note,
        })),
      },
    }
    lines.push(JSON.stringify(row))
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

// ---------- 展示辅助 ----------

/** 百分比展示：保留至多 1 位小数，去掉多余的 0 */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}
