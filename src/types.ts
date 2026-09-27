// 核心数据模型

/** 标注状态：已绑定区间 / 待人工处理（重定位失败或最高分并列、得分为 0） */
export type AnnotationStatus = 'bound' | 'pending'

/** 上一次重定位所走的策略 */
export type RelocateReason =
  | 'local-exact' // 旧位置前后 200 字内精确匹配
  | 'unique' // 全文唯一匹配
  | 'context-score' // 前后文相同字符数评分
  | 'failed' // 未找到 / 并列 / 得分为 0

export interface RelocationInfo {
  reason: RelocateReason
  /** 评分命中时的相同字符数（左右连续相同字符之和） */
  score: number
  /** 重定位所基于的旧起点（字符偏移） */
  oldStart: number
  oldEnd: number
  /** 重定位发生时所对照的原文版本（用长度+摘要生成指纹） */
  sourceFingerprint: string
  timestamp: number
}

export interface Annotation {
  id: string
  quote: string
  start: number
  end: number
  note: string
  tags: string[]
  status: AnnotationStatus
  createdAt: number
  updatedAt: number
  /** 创建 / 最近一次成功绑定时截取的上下文（两侧各 CONTEXT_RADIUS 字） */
  contextBefore: string
  contextAfter: string
  /** 上一次自动重定位的诊断信息 */
  lastRelocation?: RelocationInfo
  /** 待处理原因说明（用于界面展示，不参与算法） */
  pendingReason?: string
}

/** 互斥标签对规则：两条已绑定标注区间有字符交集，且标签分别命中同一规则的两侧时构成冲突 */
export interface ConflictRule {
  /** 稳定 ID，忽略签名以此标识「命中规则集合」 */
  id: string
  tagA: string
  tagB: string
  createdAt: number
}

/**
 * 已忽略冲突的签名：
 * 两个标注 ID（按字典序）+ 命中规则 ID 集合（排序）。
 * 不含区间信息——区间重定位后忽略仍然有效；标签 / 规则变化导致集合改变时自动重新出现。
 */
export interface IgnoredConflict {
  annotationIds: [string, string]
  ruleIds: string[]
  createdAt: number
}

/** 基线中的一条标注快照（建立基线时刻的内容） */
export interface BaselineAnnotation {
  id: string
  status: AnnotationStatus
  quote: string
  note: string
  tags: string[]
  start: number
  end: number
}

/** 唯一基线：保存时刻的全部标注快照；重建时整体替换 */
export interface AnnotationBaseline {
  createdAt: number
  annotations: BaselineAnnotation[]
}

/**
 * 一条快照差异的已审记录：标注 ID + 差异内容签名。
 * 内容再次变化 → 签名改变，记录不再命中（差异重新出现为未审）；
 * 恢复成基线 → 差异消失，记录被清理；重建基线 → 全部清空。
 */
export interface ReviewedDiff {
  annotationId: string
  signature: string
  createdAt: number
}

/** 抽样复核配置：若干标签的抽样配额 + 决定稳定顺序的种子 */
export interface SampleTarget {
  tag: string
  count: number
}

export interface SampleConfig {
  /** 任意字符串；顺序按 SHA-256(种子 + 标注 ID) 生成，同配置必得同队列 */
  seed: string
  /** 需要抽样的标签与配额，按标签名字典序排列 */
  targets: SampleTarget[]
  createdAt: number
  /** 最近一次生成 / 修改配置的时间（重建时更新） */
  updatedAt: number
}

/** 复核结论 */
export type SampleVerdict = 'pass' | 'return'

/**
 * 一条抽样复核结论：绑定「标注 ID + 标注内容签名」。
 * 标注内容（区间/绑定状态、引文、标签、备注）变化后签名改变 → 结论自动失效，需要重新复核。
 */
export interface SampleReview {
  annotationId: string
  signature: string
  verdict: SampleVerdict
  note: string
  createdAt: number
  updatedAt: number
}

/**
 * 两条标注之间的有向关系：从 sourceId 标注指向 targetId 标注，type 为用户填写的关系类型。
 * 关系本身不参与重定位；有效性由两端标注的存在与绑定状态派生：
 * 任一端被删除或进入待处理 → 关系自动标为失效；待处理端重新绑定后自动恢复。
 * 禁止自关联（sourceId === targetId）与完全重复（源、目标、类型完全相同）。
 */
export interface AnnotationRelation {
  id: string
  sourceId: string
  targetId: string
  type: string
  createdAt: number
}

/**
 * 关系基数上限规则（按关系类型配置）：
 * maxOut 为每条源标注允许的最大出边数，maxIn 为每条目标标注允许的最大入边数；
 * 留空（null）表示该方向不限。仅审计有效关系（两端标注均存在且已绑定），
 * 同一端点同一类型按创建时间、再按关系 ID 稳定排序，超出名额的关系列为违规。
 * 审计只提示，不阻止建立关系。
 */
export interface RelationCardinalityRule {
  /** 稳定 ID */
  id: string
  /** 关系类型（归一后非空，与 AnnotationRelation.type 精确匹配） */
  type: string
  /** 每条源标注允许的最大出边数；null 表示不限 */
  maxOut: number | null
  /** 每条目标标注允许的最大入边数；null 表示不限 */
  maxIn: number | null
  createdAt: number
}

export interface DocumentData {
  title: string
  text: string
  annotations: Annotation[]
  /** 互斥标签对配置，随文档本地保存 */
  conflictRules: ConflictRule[]
  /** 已忽略冲突的签名记录 */
  ignoredConflicts: IgnoredConflict[]
  /** 标签覆盖审计：应共同覆盖全文的标签集合 */
  coverageTags: string[]
  /** 标注基线快照（唯一；null 表示尚未建立） */
  baseline: AnnotationBaseline | null
  /** 快照差异已审记录：标注 ID + 差异内容签名 */
  reviewedDiffs: ReviewedDiff[]
  /** 抽样复核配置（标签配额 + 种子；null 表示尚未配置） */
  sampleConfig: SampleConfig | null
  /** 抽样复核结论：标注 ID + 标注内容签名，内容变化自动失效 */
  sampleReviews: SampleReview[]
  /** 标注之间的有向关系；任一端被删除或进入待处理时派生为失效，重新绑定后恢复 */
  relations: AnnotationRelation[]
  /** 关系基数上限规则（按类型配置出边 / 入边上限，留空表示不限；旧数据缺省按空数组处理） */
  relationCardinalityRules: RelationCardinalityRule[]
  updatedAt: number
}

/** 导出 JSON 的顶层结构 */
export interface ExportPayload {
  format: 'anchor-annotation-console'
  version: 1
  exportedAt: string
  document: {
    title: string
    text: string
    annotationCount: number
  }
  conflictRules: Array<{
    id: string
    tagA: string
    tagB: string
    createdAt: string
  }>
  ignoredConflicts: Array<{
    annotationIds: [string, string]
    ruleIds: string[]
    createdAt: string
  }>
  /** 标签覆盖审计选择的标签（旧版文件缺省时按空数组处理） */
  coverageTags: string[]
  /** 标注基线快照（旧版文件缺省时按 null 处理） */
  baseline: {
    createdAt: string
    annotations: Array<{
      id: string
      status: AnnotationStatus
      quote: string
      note: string
      tags: string[]
      position: { start: number; end: number } | null
    }>
  } | null
  /** 快照差异已审记录：标注 ID + 差异内容签名（旧版文件缺省时按空数组处理） */
  reviewedDiffs: Array<{
    annotationId: string
    signature: string
    createdAt: string
  }>
  /** 抽样复核配置（旧版文件缺省时按 null 处理） */
  sampleConfig: {
    seed: string
    targets: Array<{ tag: string; count: number }>
    createdAt: string
    updatedAt: string
  } | null
  /** 抽样复核结论：标注 ID + 标注内容签名（旧版文件缺省时按空数组处理） */
  sampleReviews: Array<{
    annotationId: string
    signature: string
    verdict: SampleVerdict
    note: string
    createdAt: string
    updatedAt: string
  }>
  /** 标注之间的有向关系（旧版文件缺省时按空数组处理） */
  relations: Array<{
    id: string
    sourceId: string
    targetId: string
    type: string
    createdAt: string
  }>
  /** 关系基数上限规则：按类型配置出边 / 入边上限（旧版文件缺省时按空数组处理） */
  relationCardinalityRules: Array<{
    id: string
    type: string
    maxOut: number | null
    maxIn: number | null
    createdAt: string
  }>
  annotations: Array<{
    id: string
    status: AnnotationStatus
    quote: string
    note: string
    tags: string[]
    position: { start: number; end: number } | null
    context: { before: string; after: string }
    pendingReason: string | null
    lastRelocation: RelocationInfo | null
    createdAt: string
    updatedAt: string
  }>
}
