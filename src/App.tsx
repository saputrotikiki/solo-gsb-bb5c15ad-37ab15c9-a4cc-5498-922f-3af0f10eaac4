import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  Annotation,
  ConflictRule,
  DocumentData,
  ExportPayload,
  IgnoredConflict,
  RelationCardinalityRule,
  SampleReview,
  SampleTarget,
  SampleVerdict,
} from './types'
import {
  fingerprint,
  makeContext,
  rebindAnnotation,
  relocateAnnotations,
  REASON_LABEL,
} from './lib/relocation'
import { buildSegments } from './lib/segments'
import { loadDocument, saveDocument } from './lib/storage'
import { clearSelection, elementAtOffset } from './lib/dom'
import {
  activeConflictRanges,
  conflictIgnoredKey,
  detectConflicts,
  ignoredKey,
  normalizeIgnored,
  normalizeRules,
  pruneIgnored,
  type ConflictItem,
} from './lib/conflicts'
import { planTagRename } from './lib/rename'
import { planBulkTags } from './lib/bulk'
import {
  auditCoverage,
  normalizeCoverageTags,
  type CoverageIssue,
} from './lib/coverage'
import {
  diffSnapshot,
  makeBaseline,
  normalizeBaseline,
  normalizeReviewedDiffs,
  pruneReviewedDiffs,
  reviewedKey,
  type SnapshotDiffItem,
} from './lib/snapshot'
import {
  annotationContentSignature,
  buildSampleQueue,
  normalizeSampleConfig,
  normalizeSampleReviews,
  pruneSampleReviews,
  sampleReviewKey,
} from './lib/sampling'
import {
  auditRelationCardinality,
  buildRelationViews,
  isSelfRelation,
  makeRelationId,
  normalizeCardinalityRules,
  normalizeRelations,
  relationKey,
  relationStats,
} from './lib/relations'
import { auditQuoteOccurrences, planQuoteBackfill } from './lib/missingQuotes'
import { TextView, type ViewRect } from './components/TextView'
import { TextEditor } from './components/TextEditor'
import { Sidebar } from './components/Sidebar'
import { Popover } from './components/Popover'
import { AnnotationForm } from './components/AnnotationForm'
import { ConflictRuleEditor } from './components/ConflictRuleEditor'
import { TagRenameEditor } from './components/TagRenameEditor'
import { badgeColor } from './lib/segments'
import { buildReviewReport, downloadHtmlFile } from './lib/report'

type PopoverState =
  | { kind: 'create'; range: { start: number; end: number }; rect: ViewRect }
  | { kind: 'inspect'; ids: string[]; rect: ViewRect }
  | { kind: 'edit'; id: string; rect: ViewRect }
  | { kind: 'rebind-confirm'; range: { start: number; end: number }; rect: ViewRect }
  | { kind: 'rules' }
  | { kind: 'rename-tags' }

interface Notice {
  id: number
  auto: number
  pending: number
}

const EMPTY_DOC: DocumentData = {
  title: '未命名文档',
  text: '',
  annotations: [],
  conflictRules: [],
  ignoredConflicts: [],
  coverageTags: [],
  baseline: null,
  reviewedDiffs: [],
  sampleConfig: null,
  sampleReviews: [],
  relations: [],
  relationCardinalityRules: [],
  updatedAt: Date.now(),
}

function makeId(): string {
  return `a_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export default function App() {
  const initialLoadedDoc = useRef<DocumentData | null>(null)
  const [doc, setDoc] = useState<DocumentData>(() => {
    const loaded = loadDocument()
    initialLoadedDoc.current = loaded
    return loaded ?? EMPTY_DOC
  })
  const [mode, setMode] = useState<'view' | 'edit'>(
    () => (initialLoadedDoc.current?.text ? 'view' : 'edit'),
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 从冲突项定位时，双方同时高亮 */
  const [activePairIds, setActivePairIds] = useState<[string, string] | null>(null)
  const [popover, setPopover] = useState<PopoverState | null>(null)
  const [rebindId, setRebindId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  /** 侧栏点击覆盖审计结果后高亮的区间 */
  const [activeCoverage, setActiveCoverage] = useState<{ start: number; end: number; key: string } | null>(null)
  /** 同引文漏标审阅：当前选中的模板标注 ID */
  const [quoteTemplateId, setQuoteTemplateId] = useState<string | null>(null)
  /** 侧栏点击漏标 / 已标注位置后高亮的区间 */
  const [activeQuoteRange, setActiveQuoteRange] = useState<{ start: number; end: number } | null>(null)
  const rootElRef = useRef<HTMLElement | null>(null)
  const conflictSectionRef = useRef<HTMLElement | null>(null)
  const coverageSectionRef = useRef<HTMLElement | null>(null)
  const quoteSectionRef = useRef<HTMLElement | null>(null)
  const snapshotSectionRef = useRef<HTMLElement | null>(null)
  const samplingSectionRef = useRef<HTMLElement | null>(null)
  const datasetSplitSectionRef = useRef<HTMLElement | null>(null)
  const relationsSectionRef = useRef<HTMLElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 本地持久化
  useEffect(() => {
    saveDocument(doc)
  }, [doc])

  // 通知自动消失
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 7000)
    return () => clearTimeout(t)
  }, [notice])

  const allTags = useMemo(() => {
    // 含规则中引用、但已无标注使用的标签（重命名入口同样需要选中它们）
    const set = new Set<string>()
    doc.annotations.forEach((a) => a.tags.forEach((t) => set.add(t)))
    doc.conflictRules.forEach((r) => {
      set.add(r.tagA)
      set.add(r.tagB)
    })
    return [...set]
  }, [doc.annotations, doc.conflictRules])

  const segments = useMemo(
    () =>
      buildSegments(
        doc.text.length,
        doc.annotations
          .filter((a) => a.status === 'bound' && a.end > a.start)
          .map((a) => ({ start: a.start, end: a.end, id: a.id })),
      ),
    [doc.text.length, doc.annotations],
  )

  const rebindTarget = doc.annotations.find((a) => a.id === rebindId) ?? null
  const pendingCount = doc.annotations.filter((a) => a.status === 'pending').length

  // ---------- 冲突检测 ----------

  const conflicts = useMemo(
    () => detectConflicts(doc.annotations, doc.conflictRules, doc.ignoredConflicts),
    [doc.annotations, doc.conflictRules, doc.ignoredConflicts],
  )
  const activeConflictCount = conflicts.filter((c) => !c.ignored).length
  const conflictRanges = useMemo(() => activeConflictRanges(conflicts), [conflicts])

  // ---------- 标签覆盖审计 ----------

  // 标签选择、标注编辑 / 重绑定、原文重定位、标签重命名后 doc 引用变化即自动重算
  const coverage = useMemo(
    () => auditCoverage(doc.annotations, doc.text.length, doc.coverageTags),
    [doc.annotations, doc.text.length, doc.coverageTags],
  )
  const coverageIssueCount = coverage.gapCount + coverage.overlapCount
  // 点击的区间若已在最新结果中消失（数据变化），取消高亮，避免指向陈旧区间
  const activeCoverageRange = activeCoverage
    ? coverage.issues.some(
        (i) =>
          i.start === activeCoverage.start &&
          i.end === activeCoverage.end &&
          activeCoverage.key.startsWith(`${i.kind}:`),
      )
      ? { start: activeCoverage.start, end: activeCoverage.end }
      : null
    : null

  // ---------- 同引文漏标审阅 ----------

  // 模板选择、原文、标注（编辑 / 重定位 / 导入）任何变化都自动重算
  const quoteAudit = useMemo(
    () =>
      quoteTemplateId
        ? auditQuoteOccurrences(doc.text, doc.annotations, quoteTemplateId)
        : null,
    [doc.text, doc.annotations, quoteTemplateId],
  )
  const quoteMissingCount = quoteAudit?.missingCount ?? 0
  // 点击的出现位置若已不在最新枚举结果中（被补过 / 原文变化），取消高亮，避免指向陈旧区间
  const activeQuoteOccurrence =
    activeQuoteRange &&
    quoteAudit?.occurrences.some(
      (o) => o.start === activeQuoteRange.start && o.end === activeQuoteRange.end,
    )
      ? activeQuoteRange
      : null

  // ---------- 标注快照对比 ----------

  // 基线或标注任何变化（编辑 / 删除 / 重绑定 / 原文重定位 / 重命名 / 导入）后自动重算
  const snapshotDiffs = useMemo(
    () => diffSnapshot(doc.baseline, doc.annotations),
    [doc.baseline, doc.annotations],
  )
  const reviewedKeySet = useMemo(
    () => new Set(doc.reviewedDiffs.map((r) => reviewedKey(r.annotationId, r.signature))),
    [doc.reviewedDiffs],
  )
  const pendingReviewCount = useMemo(
    () => snapshotDiffs.filter((d) => !reviewedKeySet.has(d.key)).length,
    [snapshotDiffs, reviewedKeySet],
  )

  // 已审记录清理：差异内容再次变化（签名失效）或恢复成基线（差异消失）后，
  // 对应「标注 ID + 签名」记录在此移除；命中当前差异的记录保留
  useEffect(() => {
    if (pruneReviewedDiffs(doc.reviewedDiffs, snapshotDiffs).length === doc.reviewedDiffs.length) {
      return
    }
    setDoc((d) => ({
      ...d,
      reviewedDiffs: pruneReviewedDiffs(d.reviewedDiffs, diffSnapshot(d.baseline, d.annotations)),
    }))
  }, [snapshotDiffs, doc.reviewedDiffs])

  // ---------- 抽样复核 ----------

  // 队列由配置与当前标注集确定性派生：同配置必得同队列，标注 / 配置变化自动重算
  const sampleQueue = useMemo(
    () => buildSampleQueue(doc.sampleConfig, doc.annotations),
    [doc.sampleConfig, doc.annotations],
  )

  // 结论失效清理：标注被删除、进入待处理或区间/引文/标签/备注变化（内容签名改变）后移除
  useEffect(() => {
    if (pruneSampleReviews(doc.sampleReviews, doc.annotations).length === doc.sampleReviews.length) {
      return
    }
    setDoc((d) => ({
      ...d,
      sampleReviews: pruneSampleReviews(d.sampleReviews, d.annotations),
    }))
  }, [doc.annotations, doc.sampleReviews])

  // 抽中项中尚未留下有效结论的数量（顶栏 / 页脚用）
  const pendingSampleCount = useMemo(() => {
    if (!doc.sampleConfig) return 0
    const validKeys = new Set(
      doc.sampleReviews.map((r) => sampleReviewKey(r.annotationId, r.signature)),
    )
    const byId = new Map(doc.annotations.map((a) => [a.id, a]))
    return sampleQueue.entries.filter((e) => {
      const a = byId.get(e.annotationId)
      return a && !validKeys.has(sampleReviewKey(a.id, annotationContentSignature(a)))
    }).length
  }, [doc.sampleConfig, doc.sampleReviews, doc.annotations, sampleQueue])

  // ---------- 标注关系 ----------

  // 有效性完全由两端标注派生：删除标注或其进入待处理 → 失效；重新绑定后自动恢复
  const relationViews = useMemo(
    () => buildRelationViews(doc.relations, doc.annotations),
    [doc.relations, doc.annotations],
  )
  const relationSummary = useMemo(() => relationStats(relationViews), [relationViews])
  const invalidRelationCount = relationSummary.invalid

  // 基数上限审计：纯派生。关系增删、两端状态变化（失效 / 恢复）、规则增删改、导入后随依赖自动重算
  const relationCardinality = useMemo(
    () => auditRelationCardinality(relationViews, doc.relationCardinalityRules),
    [relationViews, doc.relationCardinalityRules],
  )
  const relationOverCount = relationCardinality.count

  const highlightIds: string[] = activePairIds
    ? [...activePairIds]
    : activeId
      ? [activeId]
      : []

  // ---------- 选区与弹层 ----------

  const handleSelect = (range: { start: number; end: number }, rect: ViewRect) => {
    if (rebindId) {
      setPopover({ kind: 'rebind-confirm', range, rect })
    } else {
      setPopover({ kind: 'create', range, rect })
    }
  }

  const handleInspect = (ids: string[], rect: ViewRect) => {
    if (rebindId) return
    setPopover({ kind: 'inspect', ids, rect })
  }

  // ---------- 标注增改删 ----------

  const createAnnotation = (data: { note: string; tags: string[] }) => {
    if (popover?.kind !== 'create') return
    const { start, end } = popover.range
    const ctx = makeContext(doc.text, start, end)
    const now = Date.now()
    const a: Annotation = {
      id: makeId(),
      quote: doc.text.slice(start, end),
      start,
      end,
      note: data.note,
      tags: data.tags,
      status: 'bound',
      createdAt: now,
      updatedAt: now,
      contextBefore: ctx.before,
      contextAfter: ctx.after,
    }
    setDoc((d) => ({ ...d, annotations: [...d.annotations, a], updatedAt: now }))
    setActiveId(a.id)
    setPopover(null)
    clearSelection()
  }

  const saveAnnotation = (id: string, data: { note: string; tags: string[] }) => {
    setDoc((d) => ({
      ...d,
      annotations: d.annotations.map((a) =>
        a.id === id ? { ...a, ...data, updatedAt: Date.now() } : a,
      ),
    }))
    setPopover(null)
  }

  const deleteAnnotation = (id: string) => {
    setDoc((d) => {
      const annotations = d.annotations.filter((a) => a.id !== id)
      // 被删标注参与的忽略签名一并失效
      const ignoredConflicts = pruneIgnored(
        d.ignoredConflicts,
        annotations,
        d.conflictRules,
      )
      // 被删标注的抽样复核结论一并失效
      const sampleReviews = pruneSampleReviews(d.sampleReviews, annotations)
      return { ...d, annotations, ignoredConflicts, sampleReviews, updatedAt: Date.now() }
    })
    if (activeId === id) setActiveId(null)
    if (activePairIds?.includes(id)) setActivePairIds(null)
    if (rebindId === id) setRebindId(null)
    setPopover(null)
  }

  // ---------- 冲突审阅 ----------

  const saveConflictRules = (rules: ConflictRule[]) => {
    setDoc((d) => ({
      ...d,
      conflictRules: rules,
      // 被删规则导致的悬空忽略记录清理；引用仍存在规则的记录保留
      ignoredConflicts: pruneIgnored(d.ignoredConflicts, d.annotations, rules),
      updatedAt: Date.now(),
    }))
    setPopover(null)
  }

  // ---------- 标签重命名 ----------

  /**
   * 确认标签重命名：以当前文档重新计算计划（保证与预览一致），
   * 标注 / 规则 / 忽略记录在同一次 setDoc 中原子替换。
   */
  const applyTagRename = (source: string, target: string) => {
    setDoc((d) => {
      const plan = planTagRename(
        {
          annotations: d.annotations,
          conflictRules: d.conflictRules,
          ignoredConflicts: d.ignoredConflicts,
          coverageTags: d.coverageTags,
          sampleTargets: d.sampleConfig?.targets ?? [],
        },
        source,
        target,
      )
      if (!plan) return d
      const sampleConfig = d.sampleConfig
        ? { ...d.sampleConfig, targets: plan.sampleTargets }
        : null
      return {
        ...d,
        annotations: plan.annotations,
        conflictRules: plan.rules,
        ignoredConflicts: plan.ignoredConflicts,
        coverageTags: plan.coverageTags,
        sampleConfig,
        updatedAt: Date.now(),
      }
    })
    setPopover(null)
  }

  // ---------- 批量标签操作 ----------

  /**
   * 确认批量添加 / 移除标签：以当前文档重新计算计划（保证与预览一致），
   * 在同一次 setDoc 中原子替换；无实际变化（标签都已存在 / 都不持有）时不改数据。
   * 返回真正发生标签变化的标注数，供侧栏给出受影响数量提示。
   */
  const applyBulkTags = (
    selectedIds: string[],
    mode: 'add' | 'remove',
    tags: string[],
  ): number => {
    // 与侧栏预览同源（同一次渲染的 doc）：先算出实际变化数用于结果提示
    const preview = planBulkTags(doc.annotations, selectedIds, mode, tags)
    if (!preview || preview.affectedCount === 0) return 0
    const now = Date.now()
    setDoc((d) => {
      // 落地前以最新状态再算一次，保持与标签重命名相同的原子语义
      const plan = planBulkTags(d.annotations, selectedIds, mode, tags, now)
      if (!plan || plan.affectedCount === 0) return d
      // 标签变化可能使抽样复核内容签名失效，结论同步清理
      const sampleReviews = pruneSampleReviews(d.sampleReviews, plan.annotations)
      return { ...d, annotations: plan.annotations, sampleReviews, updatedAt: now }
    })
    return preview.affectedCount
  }

  const ignoreConflict = (c: ConflictItem) => {
    const rec: IgnoredConflict = {
      annotationIds: [...c.annotationIds] as [string, string],
      ruleIds: c.rules.map((r) => r.id).sort(),
      createdAt: Date.now(),
    }
    setDoc((d) => {
      // 幂等：同签名不重复写入
      const key = ignoredKey(rec.annotationIds, rec.ruleIds)
      const others = d.ignoredConflicts.filter(
        (x) => ignoredKey(x.annotationIds, x.ruleIds) !== key,
      )
      return { ...d, ignoredConflicts: [...others, rec], updatedAt: Date.now() }
    })
  }

  const unignoreConflict = (c: ConflictItem) => {
    const key = conflictIgnoredKey(c)
    setDoc((d) => ({
      ...d,
      ignoredConflicts: d.ignoredConflicts.filter(
        (x) => ignoredKey(x.annotationIds, x.ruleIds) !== key,
      ),
      updatedAt: Date.now(),
    }))
  }

  const scrollToConflicts = () => {
    conflictSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const scrollToCoverage = () => {
    coverageSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ---------- 标签覆盖审计 ----------

  const changeCoverageTags = (tags: string[]) => {
    const next = normalizeCoverageTags(tags)
    setDoc((d) => ({ ...d, coverageTags: next, updatedAt: Date.now() }))
  }

  /** 侧栏点击覆盖结果：滚动到起点并高亮整条（可能跨多段） */
  const focusCoverageIssue = (item: CoverageIssue) => {
    setActiveId(null)
    setActivePairIds(null)
    setActiveQuoteRange(null)
    setActiveCoverage({
      start: item.start,
      end: item.end,
      key: `${item.kind}:${item.start}:${item.end}`,
    })
    scrollOffsetIntoView(item.start)
  }

  // ---------- 同引文漏标审阅 ----------

  /**
   * 批量补建漏标：以当前文档重新核对勾选位置（保证与侧栏列表一致），
   * 在同一次 setDoc 中再以最新状态核对一次后原子落地；
   * 已变化或已被补过的位置自动跳过。返回补建 / 跳过条数，供侧栏给出结果提示。
   */
  const applyQuoteBackfill = (
    positions: Array<{ start: number; end: number }>,
  ): { created: number; skipped: number } => {
    if (!quoteTemplateId) return { created: 0, skipped: 0 }
    const now = Date.now()
    // 与侧栏列表同源（同一次渲染的 doc）：先算出结果用于提示
    const preview = planQuoteBackfill(doc.text, doc.annotations, quoteTemplateId, positions, now)
    if (!preview) return { created: 0, skipped: 0 }
    if (preview.created.length > 0) {
      setDoc((d) => {
        // 落地前以最新状态再核对一次，保持与批量标签相同的原子语义
        const plan = planQuoteBackfill(d.text, d.annotations, quoteTemplateId, positions, now)
        if (!plan || plan.created.length === 0) return d
        return { ...d, annotations: plan.annotations, updatedAt: now }
      })
    }
    return { created: preview.created.length, skipped: preview.skippedCount }
  }

  /** 侧栏点击出现位置：滚动到起点并高亮该区间（可跨段） */
  const focusQuoteOccurrence = (occ: { start: number; end: number }) => {
    setActiveId(null)
    setActivePairIds(null)
    setActiveCoverage(null)
    setActiveQuoteRange({ start: occ.start, end: occ.end })
    scrollOffsetIntoView(occ.start)
  }

  const scrollToQuoteSweep = () => {
    quoteSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ---------- 标注快照对比 ----------

  /** 保存 / 重建唯一基线：以当前标注集整体替换，并清空全部已审记录 */
  const saveBaseline = () => {
    if (
      doc.baseline &&
      !confirm('重建基线将覆盖现有基线，并清空全部已审记录。是否继续？')
    ) {
      return
    }
    setDoc((d) => ({
      ...d,
      baseline: makeBaseline(d.annotations),
      reviewedDiffs: [],
      updatedAt: Date.now(),
    }))
  }

  const clearBaseline = () => {
    if (!confirm('清除基线后，全部差异与已审记录将被移除。是否继续？')) return
    setDoc((d) => ({
      ...d,
      baseline: null,
      reviewedDiffs: [],
      updatedAt: Date.now(),
    }))
  }

  /** 标记 / 取消已审：以「标注 ID + 差异内容签名」落库 */
  const toggleReview = (item: SnapshotDiffItem) => {
    setDoc((d) => {
      const exists = d.reviewedDiffs.some(
        (r) => reviewedKey(r.annotationId, r.signature) === item.key,
      )
      return {
        ...d,
        reviewedDiffs: exists
          ? d.reviewedDiffs.filter(
              (r) => reviewedKey(r.annotationId, r.signature) !== item.key,
            )
          : [
              ...d.reviewedDiffs,
              {
                annotationId: item.annotationId,
                signature: item.signature,
                createdAt: Date.now(),
              },
            ],
        updatedAt: Date.now(),
      }
    })
  }

  const scrollToSnapshot = () => {
    snapshotSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ---------- 抽样复核 ----------

  /** 保存 / 更新抽样配置：配额清洗（≥1 的整数、按标签排序去重），队列由数据确定性派生 */
  const saveSampleConfig = (seed: string, targets: SampleTarget[]) => {
    const now = Date.now()
    setDoc((d) => ({
      ...d,
      sampleConfig: {
        seed,
        targets,
        createdAt: d.sampleConfig?.createdAt ?? now,
        updatedAt: now,
      },
      updatedAt: now,
    }))
  }

  const clearSampleConfig = () => {
    setDoc((d) => ({ ...d, sampleConfig: null, updatedAt: Date.now() }))
  }

  /** 写入 / 覆盖 / 清除一条复核结论：以「标注 ID + 当前内容签名」落库，内容变化自动失效 */
  const setSampleReview = (
    annotation: Annotation,
    verdict: SampleVerdict | null,
    note: string,
  ) => {
    const signature = annotationContentSignature(annotation)
    const key = sampleReviewKey(annotation.id, signature)
    setDoc((d) => {
      const others = d.sampleReviews.filter(
        (r) => sampleReviewKey(r.annotationId, r.signature) !== key,
      )
      if (!verdict) {
        return { ...d, sampleReviews: others, updatedAt: Date.now() }
      }
      const prev = d.sampleReviews.find(
        (r) => sampleReviewKey(r.annotationId, r.signature) === key,
      )
      const now = Date.now()
      const rec: SampleReview = {
        annotationId: annotation.id,
        signature,
        verdict,
        note,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      }
      return { ...d, sampleReviews: [...others, rec], updatedAt: now }
    })
  }

  const scrollToSampling = () => {
    samplingSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const scrollToDatasetSplit = () => {
    datasetSplitSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ---------- 标注关系 ----------

  /**
   * 建立有向关系：源、目标必须是两条不同的已绑定标注，类型非空；
   * 「源 + 目标 + 类型」完全相同（方向敏感）的关系拒绝重复建立。
   */
  const createRelation = (sourceId: string, targetId: string, rawType: string) => {
    const type = rawType.trim()
    if (!sourceId || !targetId || !type) return
    if (isSelfRelation(sourceId, targetId)) return
    const byId = new Map(doc.annotations.map((a) => [a.id, a]))
    const source = byId.get(sourceId)
    const target = byId.get(targetId)
    if (!source || !target || source.status !== 'bound' || target.status !== 'bound') return
    const key = relationKey(sourceId, targetId, type)
    if (doc.relations.some((r) => relationKey(r.sourceId, r.targetId, r.type) === key)) return
    const now = Date.now()
    setDoc((d) => ({
      ...d,
      relations: [
        ...d.relations,
        { id: makeRelationId(), sourceId, targetId, type, createdAt: now },
      ],
      updatedAt: now,
    }))
  }

  const deleteRelation = (id: string) => {
    setDoc((d) => ({
      ...d,
      relations: d.relations.filter((r) => r.id !== id),
      updatedAt: Date.now(),
    }))
  }

  /** 保存基数上限规则（编辑器已校验类型与名额），保存后审计随 memo 实时重算 */
  const saveRelationCardinalityRules = (rules: RelationCardinalityRule[]) => {
    setDoc((d) => ({ ...d, relationCardinalityRules: rules, updatedAt: Date.now() }))
  }

  const scrollToRelations = () => {
    relationsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // ---------- 编辑原文与重定位 ----------

  const applyEdit = (title: string, text: string) => {
    const oldFingerprint = fingerprint(doc.text)
    const textChanged = text !== doc.text

    if (textChanged && doc.annotations.length > 0) {
      const relocated = relocateAnnotations(doc.annotations, text, oldFingerprint)
      const auto = relocated.filter(
        (a) => a.status === 'bound' && a.lastRelocation?.reason !== 'failed',
      ).length
      const pending = relocated.filter((a) => a.status === 'pending').length
      setDoc((d) => ({
        ...d,
        title,
        text,
        annotations: relocated,
        updatedAt: Date.now(),
      }))
      setNotice({ id: Date.now(), auto, pending })
    } else {
      setDoc((d) => ({ ...d, title, text, updatedAt: Date.now() }))
    }

    setMode('view')
    setPopover(null)
    setActiveId(null)
    setActivePairIds(null)
    setActiveCoverage(null)
    setActiveQuoteRange(null)
    clearSelection()
  }

  // ---------- 手动重新绑定 ----------

  const startRebind = (a: Annotation) => {
    setRebindId(a.id)
    setActiveId(a.id)
    setPopover(null)
    clearSelection()
  }

  const cancelRebind = () => {
    setRebindId(null)
    setPopover(null)
    clearSelection()
  }

  const confirmRebind = (range: { start: number; end: number }) => {
    if (!rebindId) return
    setDoc((d) => ({
      ...d,
      annotations: d.annotations.map((a) =>
        a.id === rebindId ? rebindAnnotation(a, d.text, range.start, range.end) : a,
      ),
      updatedAt: Date.now(),
    }))
    setRebindId(null)
    setPopover(null)
    clearSelection()
  }

  // ---------- 定位 ----------

  const scrollOffsetIntoView = (offset: number) => {
    requestAnimationFrame(() => {
      const el = elementAtOffset(rootElRef.current as HTMLElement, offset)
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }

  const focusAnnotation = (a: Annotation) => {
    if (a.status !== 'bound') return
    setActivePairIds(null)
    setActiveCoverage(null)
    setActiveQuoteRange(null)
    setActiveId(a.id)
    scrollOffsetIntoView(a.start)
  }

  /** 定位冲突双方：两个标注同时高亮，滚动到交叠起点 */
  const focusConflict = (c: ConflictItem) => {
    setActiveId(null)
    setActiveCoverage(null)
    setActiveQuoteRange(null)
    setActivePairIds([...c.annotationIds] as [string, string])
    scrollOffsetIntoView(c.overlapStart)
  }

  // ---------- 导入 / 导出 / 新建 ----------

  const exportJson = () => {
    const payload: ExportPayload = {
      format: 'anchor-annotation-console',
      version: 1,
      exportedAt: new Date().toISOString(),
      document: {
        title: doc.title,
        text: doc.text,
        annotationCount: doc.annotations.length,
      },
      conflictRules: doc.conflictRules.map((r) => ({
        id: r.id,
        tagA: r.tagA,
        tagB: r.tagB,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
      ignoredConflicts: doc.ignoredConflicts.map((g) => ({
        annotationIds: [...g.annotationIds] as [string, string],
        ruleIds: [...g.ruleIds],
        createdAt: new Date(g.createdAt).toISOString(),
      })),
      coverageTags: [...doc.coverageTags],
      baseline: doc.baseline
        ? {
            createdAt: new Date(doc.baseline.createdAt).toISOString(),
            annotations: doc.baseline.annotations.map((b) => ({
              id: b.id,
              status: b.status,
              quote: b.quote,
              note: b.note,
              tags: [...b.tags],
              position: b.status === 'bound' ? { start: b.start, end: b.end } : null,
            })),
          }
        : null,
      reviewedDiffs: doc.reviewedDiffs.map((r) => ({
        annotationId: r.annotationId,
        signature: r.signature,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
      sampleConfig: doc.sampleConfig
        ? {
            seed: doc.sampleConfig.seed,
            targets: doc.sampleConfig.targets.map((t) => ({
              tag: t.tag,
              count: t.count,
            })),
            createdAt: new Date(doc.sampleConfig.createdAt).toISOString(),
            updatedAt: new Date(doc.sampleConfig.updatedAt).toISOString(),
          }
        : null,
      sampleReviews: doc.sampleReviews.map((r) => ({
        annotationId: r.annotationId,
        signature: r.signature,
        verdict: r.verdict,
        note: r.note,
        createdAt: new Date(r.createdAt).toISOString(),
        updatedAt: new Date(r.updatedAt).toISOString(),
      })),
      relations: doc.relations.map((r) => ({
        id: r.id,
        sourceId: r.sourceId,
        targetId: r.targetId,
        type: r.type,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
      relationCardinalityRules: doc.relationCardinalityRules.map((r) => ({
        id: r.id,
        type: r.type,
        maxOut: r.maxOut,
        maxIn: r.maxIn,
        createdAt: new Date(r.createdAt).toISOString(),
      })),
      annotations: doc.annotations.map((a) => ({
        id: a.id,
        status: a.status,
        quote: a.quote,
        note: a.note,
        tags: a.tags,
        position: a.status === 'bound' ? { start: a.start, end: a.end } : null,
        context: { before: a.contextBefore, after: a.contextAfter },
        pendingReason: a.pendingReason ?? null,
        lastRelocation: a.lastRelocation ?? null,
        createdAt: new Date(a.createdAt).toISOString(),
        updatedAt: new Date(a.updatedAt).toISOString(),
      })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const safeTitle = doc.title.replace(/[\\/:*?"<>|\s]+/g, '_')
    link.href = url
    link.download = `标注导出_${safeTitle}_${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as ExportPayload
      if (parsed.format !== 'anchor-annotation-console' || typeof parsed.document?.text !== 'string') {
        alert('无法识别的文件格式，请选择本工具导出的 JSON。')
        return
      }
      if (
        !confirm(
          `导入「${parsed.document.title}」将替换当前文档（当前本地数据可先导出备份）。是否继续？`,
        )
      ) {
        return
      }
      const annotations: Annotation[] = parsed.annotations.map((x, i) => ({
        id: x.id || `imp_${i}`,
        quote: x.quote,
        start: x.position?.start ?? 0,
        end: x.position?.end ?? 0,
        note: x.note,
        tags: x.tags,
        status: x.status,
        createdAt: x.createdAt ? Date.parse(x.createdAt) || Date.now() : Date.now(),
        updatedAt: x.updatedAt ? Date.parse(x.updatedAt) || Date.now() : Date.now(),
        contextBefore: x.context?.before ?? '',
        contextAfter: x.context?.after ?? '',
        pendingReason: x.pendingReason ?? undefined,
        lastRelocation: x.lastRelocation ?? undefined,
      }))
      const conflictRules = normalizeRules(parsed.conflictRules)
      // 旧版导出文件不含基线 / 已审记录：无损补空
      const baselineRaw = parsed.baseline
      const baseline =
        baselineRaw && typeof baselineRaw === 'object'
          ? normalizeBaseline({
              createdAt: baselineRaw.createdAt,
              annotations: (baselineRaw.annotations ?? []).map((b) => ({
                id: b.id,
                status: b.status,
                quote: b.quote,
                note: b.note,
                tags: b.tags,
                start: b.position?.start ?? 0,
                end: b.position?.end ?? 0,
              })),
            })
          : null
      // 仅保留仍能命中导入后差异的已审记录
      const reviewedDiffs = pruneReviewedDiffs(
        normalizeReviewedDiffs(parsed.reviewedDiffs),
        diffSnapshot(baseline, annotations),
      )
      // 旧版导出文件不含抽样配置：无损补空
      const sampleConfig = normalizeSampleConfig(parsed.sampleConfig)
      // 仅保留引用的标注仍存在、仍已绑定且内容签名一致的复核结论
      const sampleReviews = pruneSampleReviews(
        normalizeSampleReviews(parsed.sampleReviews),
        annotations,
      )
      // 旧版导出文件不含标注关系：无损补空。
      // 有效性不在导入时裁决：引用待处理 / 已不存在标注的关系保留为失效记录，
      // 重新绑定后可自动恢复（引用完全缺失 ID 时只显示失效，不丢弃）。
      const relations = normalizeRelations(parsed.relations)
      // 旧版导出文件不含基数上限规则：无损补空；规则只按类型生效，与关系是否存在无关
      const relationCardinalityRules = normalizeCardinalityRules(parsed.relationCardinalityRules)
      setDoc({
        title: parsed.document.title,
        text: parsed.document.text,
        annotations,
        // 旧版导出文件不含冲突配置：无损补空；忽略记录引用已删标注/规则的在此剔除
        conflictRules,
        ignoredConflicts: pruneIgnored(
          normalizeIgnored(parsed.ignoredConflicts),
          annotations,
          conflictRules,
        ),
        // 旧版导出文件不含覆盖审计配置：无损补空
        coverageTags: normalizeCoverageTags(parsed.coverageTags),
        baseline,
        reviewedDiffs,
        sampleConfig,
        sampleReviews,
        relations,
        relationCardinalityRules,
        updatedAt: Date.now(),
      })
      setMode('view')
      setPopover(null)
      setRebindId(null)
      setActiveId(null)
      setActivePairIds(null)
      setActiveCoverage(null)
      setActiveQuoteRange(null)
    } catch {
      alert('文件解析失败，请确认是有效的 JSON 导出文件。')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const newDocument = () => {
    if (
      doc.annotations.length > 0 &&
      !confirm('将清空当前原文与全部标注（建议先导出 JSON 备份），确定新建吗？')
    ) {
      return
    }
    setDoc({ ...EMPTY_DOC, updatedAt: Date.now() })
    setMode('edit')
    setPopover(null)
    setRebindId(null)
    setActiveId(null)
    setActivePairIds(null)
    setActiveCoverage(null)
    setActiveQuoteRange(null)
  }

  // ---------- 审阅报告 ----------

  /**
   * 生成并下载自包含 HTML 审阅报告：
   * 直接以当前 doc 为快照读取（不调用 setDoc、不写 localStorage），
   * 冲突 / 覆盖结果与界面上的口径完全一致。
   */
  const downloadReviewReport = () => {
    if (!doc.text) return
    const report = buildReviewReport({
      title: doc.title,
      text: doc.text,
      annotations: doc.annotations,
      conflictRules: doc.conflictRules,
      ignoredConflicts: doc.ignoredConflicts,
      coverageTags: doc.coverageTags,
      relations: doc.relations,
      relationCardinalityRules: doc.relationCardinalityRules,
    })
    downloadHtmlFile(report.filename, report.html)
  }

  // ---------- 渲染 ----------

  const editingAnnotation = popover?.kind === 'edit'
    ? doc.annotations.find((a) => a.id === popover.id) ?? null
    : null

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">⚓</span>
          <span className="brand-name">原文锚点标注台</span>
        </div>
        <div className="doc-title-wrap">
          {mode === 'view' && <h1 className="doc-title">{doc.title}</h1>}
        </div>
        <div className="topbar-actions">
          {mode === 'view' ? (
            <button className="btn btn-primary" onClick={() => setMode('edit')}>
              {doc.text ? '粘贴 / 编辑原文' : '粘贴原文'}
            </button>
          ) : (
            <button className="btn btn-ghost" onClick={() => setMode('view')} disabled={!doc.text}>
              返回查看
            </button>
          )}
          {mode === 'view' && (
            <button
              className={`btn ${activeConflictCount > 0 ? 'btn-warn' : 'btn-ghost'}`}
              onClick={scrollToConflicts}
              title="查看互斥标签的区间交叠冲突"
            >
              冲突审阅
              {activeConflictCount > 0 && <span className="topbar-count">{activeConflictCount}</span>}
            </button>
          )}
          {mode === 'view' && (
            <button
              className={`btn ${coverageIssueCount > 0 ? 'btn-warn' : 'btn-ghost'}`}
              onClick={scrollToCoverage}
              title="查看标签覆盖全文的缺口与重叠"
            >
              覆盖审计
              {coverageIssueCount > 0 && <span className="topbar-count">{coverageIssueCount}</span>}
            </button>
          )}
          {mode === 'view' && (
            <button
              className={`btn ${quoteMissingCount > 0 ? 'btn-warn' : 'btn-ghost'}`}
              onClick={scrollToQuoteSweep}
              title="以一条已绑定标注为模板，审阅其引文在全文中漏标的位置"
            >
              漏标审阅
              {quoteMissingCount > 0 && <span className="topbar-count">{quoteMissingCount}</span>}
            </button>
          )}
          {mode === 'view' && (
            <button
              className={`btn ${pendingReviewCount > 0 ? 'btn-warn' : 'btn-ghost'}`}
              onClick={scrollToSnapshot}
              title="与基线快照对比标注差异"
            >
              快照对比
              {pendingReviewCount > 0 && <span className="topbar-count">{pendingReviewCount}</span>}
            </button>
          )}
          {mode === 'view' && (
            <button
              className={`btn ${pendingSampleCount > 0 ? 'btn-warn' : 'btn-ghost'}`}
              onClick={scrollToSampling}
              title="按标签配额与种子抽样复核已绑定标注"
            >
              抽样复核
              {pendingSampleCount > 0 && <span className="topbar-count">{pendingSampleCount}</span>}
            </button>
          )}
          {mode === 'view' && (
            <button
              className="btn btn-ghost"
              onClick={scrollToDatasetSplit}
              title="按区间连通组与稳定种子划分 train / validation / test 并导出 JSONL"
            >
              训练集划分
            </button>
          )}
          {mode === 'view' && (
            <button
              className={`btn ${invalidRelationCount + relationOverCount > 0 ? 'btn-warn' : 'btn-ghost'}`}
              onClick={scrollToRelations}
              title="在两条已绑定标注之间建立有向关系；失效关系与基数上限违规在此审阅"
            >
              标注关系
              {(invalidRelationCount + relationOverCount > 0) && (
                <span className="topbar-count">{invalidRelationCount + relationOverCount}</span>
              )}
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => fileInputRef.current?.click()}>
            导入 JSON
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void importJson(f)
            }}
          />
          <button
            className="btn btn-ghost"
            onClick={exportJson}
            disabled={!doc.text}
            title="导出含原文、引文、上下文及状态的 JSON"
          >
            导出 JSON
          </button>
          <button className="btn btn-ghost" onClick={newDocument}>
            新建
          </button>
        </div>
      </header>

      {notice && (
        <div className={`toast ${notice.pending > 0 ? 'toast-warn' : ''}`}>
          {notice.auto > 0 && <span>{notice.auto} 条标注已自动重定位。</span>}
          {notice.pending > 0 && (
            <strong>{notice.pending} 条标注进入待处理列表，需要手动绑定。</strong>
          )}
          <button className="toast-close" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}

      {mode === 'edit' ? (
        <main className="main main-edit">
          <TextEditor
            initialTitle={doc.title}
            initialText={doc.text}
            annotationCount={doc.annotations.length}
            onCancel={() => setMode(doc.text ? 'view' : 'edit')}
            onApply={applyEdit}
          />
        </main>
      ) : (
        <main className="main">
          <section className="content-pane">
            {rebindTarget && (
              <div className="rebind-banner">
                <span>
                  正在为待处理标注选择新区间：
                  <strong>「{rebindTarget.quote.slice(0, 40) || '空引文'}
                  {rebindTarget.quote.length > 40 ? '…' : ''}」</strong>
                  ，请在原文中拖选目标片段。
                </span>
                <button className="btn btn-small btn-ghost" onClick={cancelRebind}>
                  取消绑定
                </button>
              </div>
            )}
            <div className="text-scroll">
              <TextView
                text={doc.text}
                segments={segments}
                activeIds={highlightIds}
                rebinding={!!rebindId}
                conflictRanges={conflictRanges}
                coverageKindByStart={coverage.marksByStart}
                activeCoverageRange={activeCoverageRange}
                activeQuoteRange={activeQuoteOccurrence}
                onSelect={handleSelect}
                onInspect={handleInspect}
                registerRef={(el) => {
                  rootElRef.current = el
                }}
              />
            </div>
            <footer className="content-foot">
              共 {doc.text.length} 字 · {doc.annotations.length} 条标注
              {pendingCount > 0 && <span className="foot-pending">（{pendingCount} 条待处理）</span>}
              {activeConflictCount > 0 && <span className="foot-conflict">（{activeConflictCount} 条冲突待审阅）</span>}
              {doc.coverageTags.length > 0 && coverageIssueCount > 0 && (
                <span className="foot-coverage">（{coverageIssueCount} 处覆盖问题）</span>
              )}
              {quoteAudit && quoteMissingCount > 0 && (
                <span className="foot-quote-sweep">（{quoteMissingCount} 处同引文漏标）</span>
              )}
              {doc.baseline && pendingReviewCount > 0 && (
                <span className="foot-snapshot">（{pendingReviewCount} 条快照差异待审）</span>
              )}
              {doc.sampleConfig && pendingSampleCount > 0 && (
                <span className="foot-sampling">（{pendingSampleCount} 条抽样待复核）</span>
              )}
              {relationSummary.total > 0 && invalidRelationCount > 0 && (
                <span className="foot-relation">（{invalidRelationCount} 条关系失效）</span>
              )}
              {relationOverCount > 0 && (
                <span className="foot-relation-over">（{relationOverCount} 条关系基数超限）</span>
              )}
              {' '}· 数据自动保存在本浏览器
            </footer>
          </section>

          <Sidebar
            ref={conflictSectionRef}
            title={doc.title}
            text={doc.text}
            annotations={doc.annotations}
            activeId={activeId ?? activePairIds?.[0] ?? null}
            conflictRules={doc.conflictRules}
            conflicts={conflicts}
            coverageTags={doc.coverageTags}
            coverageResult={coverage}
            activeCoverageKey={activeCoverage?.key ?? null}
            onChangeCoverageTags={changeCoverageTags}
            onFocusCoverage={focusCoverageIssue}
            coverageSectionRef={coverageSectionRef}
            quoteTemplateId={quoteTemplateId}
            quoteAudit={quoteAudit}
            activeQuoteRange={activeQuoteOccurrence}
            onChangeQuoteTemplate={setQuoteTemplateId}
            onBackfillQuotes={applyQuoteBackfill}
            onFocusQuoteOccurrence={focusQuoteOccurrence}
            quoteSectionRef={quoteSectionRef}
            baseline={doc.baseline}
            snapshotDiffs={snapshotDiffs}
            reviewedKeys={reviewedKeySet}
            onSaveBaseline={saveBaseline}
            onClearBaseline={clearBaseline}
            onToggleReview={toggleReview}
            snapshotSectionRef={snapshotSectionRef}
            sampleConfig={doc.sampleConfig}
            sampleQueue={sampleQueue}
            sampleReviews={doc.sampleReviews}
            onSaveSampleConfig={saveSampleConfig}
            onClearSampleConfig={clearSampleConfig}
            onSetSampleReview={setSampleReview}
            samplingSectionRef={samplingSectionRef}
            datasetSplitSectionRef={datasetSplitSectionRef}
            relationViews={relationViews}
            relationCardinality={relationCardinality.violations}
            relationCardinalityRules={doc.relationCardinalityRules}
            onSaveRelationCardinalityRules={saveRelationCardinalityRules}
            onCreateRelation={createRelation}
            onDeleteRelation={deleteRelation}
            relationsSectionRef={relationsSectionRef}
            onFocus={focusAnnotation}
            onEdit={(a) =>
              setPopover({
                kind: 'edit',
                id: a.id,
                rect: { top: -1, bottom: -1, left: -1, right: -1 },
              })
            }
            onRebindStart={startRebind}
            onDelete={(a) => deleteAnnotation(a.id)}
            onFocusOverlap={focusConflict}
            onIgnore={ignoreConflict}
            onUnignore={unignoreConflict}
            onConfigureRules={() => setPopover({ kind: 'rules' })}
            onRenameTags={() => setPopover({ kind: 'rename-tags' })}
            onBulkApply={applyBulkTags}
            tagCount={allTags.length}
            allTags={allTags}
            onDownloadReport={downloadReviewReport}
          />
        </main>
      )}

      {/* 浮动面板 */}
      {popover && (
        <Popover
          rect={
            popover.kind === 'rules' || popover.kind === 'rename-tags'
              ? { top: -1, bottom: -1, left: -1, right: -1 }
              : popover.rect
          }
          onClose={() => setPopover(null)}
        >
          {popover.kind === 'create' && (
            <AnnotationForm
              mode="create"
              quote={doc.text.slice(popover.range.start, popover.range.end)}
              allTags={allTags}
              onCancel={() => {
                setPopover(null)
                clearSelection()
              }}
              onCreate={createAnnotation}
            />
          )}

          {popover.kind === 'edit' && editingAnnotation && (
            <AnnotationForm
              mode="edit"
              annotation={editingAnnotation}
              allTags={allTags}
              onCancel={() => setPopover(null)}
              onSave={(data) => saveAnnotation(editingAnnotation.id, data)}
              onDelete={() => deleteAnnotation(editingAnnotation.id)}
            />
          )}

          {popover.kind === 'rebind-confirm' && (
            <div className="annotation-form">
              <div className="form-title">确认绑定到新片段</div>
              <blockquote className="form-quote">
                {doc.text.slice(popover.range.start, popover.range.end)}
              </blockquote>
              <p className="form-hint">
                绑定后引文与上下文快照将更新为新位置内容，之后的编辑仍可据此自动重定位。
              </p>
              <div className="form-actions">
                <span className="form-spacer" />
                <button className="btn btn-ghost" onClick={() => setPopover(null)}>
                  重新选择
                </button>
                <button className="btn btn-primary" onClick={() => confirmRebind(popover.range)}>
                  确认绑定
                </button>
              </div>
            </div>
          )}

          {popover.kind === 'inspect' && (
            <div className="inspect-list">
              <div className="form-title">
                此区间的 {popover.ids.length} 条标注
              </div>
              {popover.ids.map((id) => {
                const a = doc.annotations.find((x) => x.id === id)
                if (!a) return null
                return (
                  <div key={id} className="inspect-item">
                    <div className="inspect-head">
                      <span
                        className="ann-badge"
                        style={{ backgroundColor: badgeColor(a.id) }}
                      />
                      {a.tags.map((t) => (
                        <span className="ann-tag" key={t}>
                          #{t}
                        </span>
                      ))}
                      <span className="form-spacer" />
                      <button
                        className="btn btn-small btn-ghost"
                        onClick={() => setPopover({ kind: 'edit', id, rect: popover.rect })}
                      >
                        编辑
                      </button>
                    </div>
                    <p className="inspect-note">{a.note || <em>（无备注）</em>}</p>
                    {a.lastRelocation && a.lastRelocation.reason !== 'failed' && (
                      <p className="ann-meta">
                        {REASON_LABEL[a.lastRelocation.reason]}
                        {a.lastRelocation.reason === 'context-score' &&
                          `（${a.lastRelocation.score} 字）`}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {popover.kind === 'rules' && (
            <ConflictRuleEditor
              rules={doc.conflictRules}
              allTags={allTags}
              onCancel={() => setPopover(null)}
              onSave={saveConflictRules}
            />
          )}
          {popover.kind === 'rename-tags' && (
            <TagRenameEditor
              annotations={doc.annotations}
              conflictRules={doc.conflictRules}
              ignoredConflicts={doc.ignoredConflicts}
              coverageTags={doc.coverageTags}
              allTags={allTags}
              onCancel={() => setPopover(null)}
              onApply={applyTagRename}
            />
          )}
        </Popover>
      )}
    </div>
  )
}
