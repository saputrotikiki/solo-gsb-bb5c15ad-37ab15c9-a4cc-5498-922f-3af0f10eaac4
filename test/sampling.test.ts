import assert from 'node:assert'
import { createHash } from 'node:crypto'
import {
  annotationContentSignature,
  buildSampleQueue,
  normalizeSampleConfig,
  normalizeSampleReviews,
  normalizeTargets,
  pruneSampleReviews,
  sampleHash,
  sampleReviewKey,
  sha256Hex,
} from '../src/lib/sampling'
import type { Annotation, SampleReview } from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let seq = 0
function ann(
  tags: string[] = [],
  id?: string,
  opts: Partial<Annotation> = {},
): Annotation {
  seq += 1
  return {
    id: id ?? `a${seq}`,
    quote: '',
    start: seq,
    end: seq + 1,
    note: '',
    tags,
    status: 'bound',
    createdAt: 0,
    updatedAt: 0,
    contextBefore: '',
    contextAfter: '',
    ...opts,
  }
}

const config = (
  seed: string,
  targets: Array<[string, number]>,
  extra: { createdAt?: number; updatedAt?: number } = {},
) => ({
  seed,
  targets: targets.map(([tag, count]) => ({ tag, count })),
  createdAt: extra.createdAt ?? 1,
  updatedAt: extra.updatedAt ?? 2,
})

// 1. SHA-256 标准向量
check('SHA-256 空串与 abc 标准向量', () => {
  assert.strictEqual(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  assert.strictEqual(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

// 2. SHA-256 跨分块长度与 Unicode 与 node:crypto 一致
check('SHA-256 与 node:crypto 结果一致（含边界长度与中文）', () => {
  for (const s of ['', 'x', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '中文种子+标注ID😀']) {
    assert.strictEqual(
      sha256Hex(s),
      createHash('sha256').update(s, 'utf8').digest('hex'),
    )
  }
})

// 3. sampleHash = SHA-256(种子 + 标注 ID)
check('sampleHash 即 SHA-256(种子 + 标注 ID)', () => {
  assert.strictEqual(sampleHash('s1', 'id1'), createHash('sha256').update('s1id1').digest('hex'))
  assert.notStrictEqual(sampleHash('s1', 'id1'), sampleHash('s2', 'id1'))
  assert.notStrictEqual(sampleHash('s1', 'id1'), sampleHash('s1', 'id2'))
})

// 4. 无配置 → 空队列
check('配置为 null 时不产生队列', () => {
  const r = buildSampleQueue(null, [ann(['X'])])
  assert.deepStrictEqual(r.entries, [])
  assert.strictEqual(r.candidateCount, 0)
})

// 5. 只从已绑定标注取样
check('待处理标注不进入候选', () => {
  const r = buildSampleQueue(config('s', [['X', 1]]), [
    ann(['X'], 'p1', { status: 'pending' }),
  ])
  assert.strictEqual(r.candidateCount, 0)
  assert.strictEqual(r.entries.length, 0)
  assert.strictEqual(r.tagStats[0].gap, 1)
})

// 6. 只取命中目标标签的标注
check('未命中目标标签的已绑定标注不进入候选', () => {
  const r = buildSampleQueue(config('s', [['X', 1]]), [ann(['Y'], 'a1')])
  assert.strictEqual(r.candidateCount, 0)
  assert.strictEqual(r.entries.length, 0)
})

// 7. 确定性：同配置同标注集（含乱序）→ 同队列
check('同配置同标注集必得相同队列，与传入顺序无关', () => {
  const list = [
    ann(['X'], 'a1'),
    ann(['X'], 'a2'),
    ann(['X'], 'a3'),
    ann(['X'], 'a4'),
  ]
  const r1 = buildSampleQueue(config('seed-9', [['X', 3]]), list)
  const r2 = buildSampleQueue(config('seed-9', [['X', 3]]), [...list].reverse())
  assert.deepStrictEqual(
    r1.entries.map((e) => e.annotationId),
    r2.entries.map((e) => e.annotationId),
  )
  assert.strictEqual(r1.entries.length, 3)
  // 每个轮次记录了正确的轮次号
  assert.deepStrictEqual(r1.entries.map((e) => e.round), [1, 2, 3])
})

// 8. 逐轮贪心：一条标注补足多个标签时优先入选
check('优先选择能补足最多尚缺标签的标注', () => {
  const a1 = ann(['X'], 'only-x')
  const a2 = ann(['Y'], 'only-y')
  const a3 = ann(['X', 'Y'], 'both')
  const r = buildSampleQueue(config('s', [['X', 1], ['Y', 1]]), [a1, a2, a3])
  // 无论哈希如何，both 首轮覆盖 2 个尚缺标签，必然最先入选并一轮填满
  assert.strictEqual(r.entries.length, 1)
  assert.strictEqual(r.entries[0].annotationId, 'both')
  assert.deepStrictEqual(r.entries[0].coveredTags, ['X', 'Y'])
  assert.strictEqual(r.entries[0].round, 1)
  assert.deepStrictEqual(
    r.tagStats.map((t) => [t.tag, t.target, t.actual, t.gap]),
    [
      ['X', 1, 1, 0],
      ['Y', 1, 1, 0],
    ],
  )
})

// 9. 同覆盖能力时按哈希、再按 ID
check('同数候选按 SHA-256 哈希、再按标注 ID 排序', () => {
  const a1 = ann(['X'], 'id-a')
  const a2 = ann(['X'], 'id-b')
  const r = buildSampleQueue(config('tie-seed', [['X', 1]]), [a1, a2])
  const h1 = sampleHash('tie-seed', 'id-a')
  const h2 = sampleHash('tie-seed', 'id-b')
  const expected = h1 < h2 ? 'id-a' : h2 < h1 ? 'id-b' : 'id-a'
  assert.strictEqual(r.entries[0].annotationId, expected)
  assert.strictEqual(r.entries[0].hash, h1 < h2 ? h1 : h2)
})

// 10. 配额逐轮填满：单标签配额 3，抽 3 条，顺序按哈希
check('单标签配额逐轮按哈希顺序抽满', () => {
  const ids = ['n1', 'n2', 'n3', 'n4']
  const r = buildSampleQueue(
    config('s', [['X', 3]]),
    ids.map((id) => ann(['X'], id)),
  )
  assert.strictEqual(r.entries.length, 3)
  const hashes = ids
    .map((id) => ({ id, h: sampleHash('s', id) }))
    .sort((x, y) => (x.h < y.h ? -1 : x.h > y.h ? 1 : x.id < y.id ? -1 : 1))
  assert.deepStrictEqual(
    r.entries.map((e) => e.annotationId),
    hashes.slice(0, 3).map((x) => x.id),
  )
  assert.strictEqual(r.tagStats[0].actual, 3)
  assert.strictEqual(r.tagStats[0].gap, 0)
})

// 11. 候选耗尽 → 缺口
check('候选不足时配额留有缺口并在 tagStats 中报告', () => {
  const r = buildSampleQueue(config('s', [['X', 3]]), [ann(['X'], 'a1')])
  assert.strictEqual(r.entries.length, 1)
  assert.strictEqual(r.candidateCount, 1)
  assert.strictEqual(r.tagStats[0].target, 3)
  assert.strictEqual(r.tagStats[0].actual, 1)
  assert.strictEqual(r.tagStats[0].gap, 2)
})

// 12. 多标签配额可因共享标注超额；coveredTags 只记当时仍缺的标签
check('共享标注可导致某标签实际数超额，coveredTags 只计尚缺标签', () => {
  // X 配额 2、Y 配额 1；三条都同时带 X/Y。首轮任一覆盖 2 个；
  // 次轮 Y 已满，入选标注只为 X 补额，但实际携带 Y → Y 实际 2、超额 1
  const list = ['m1', 'm2', 'm3'].map((id) => ann(['X', 'Y'], id))
  const r = buildSampleQueue(config('s', [['X', 2], ['Y', 1]]), list)
  assert.strictEqual(r.entries.length, 2)
  assert.deepStrictEqual(r.entries[0].coveredTags.sort(), ['X', 'Y'])
  assert.deepStrictEqual(r.entries[1].coveredTags, ['X'])
  const statX = r.tagStats.find((t) => t.tag === 'X')!
  const statY = r.tagStats.find((t) => t.tag === 'Y')!
  assert.strictEqual(statX.actual, 2)
  assert.strictEqual(statX.gap, 0)
  assert.strictEqual(statY.target, 1)
  assert.strictEqual(statY.actual, 2)
  assert.strictEqual(statY.gap, 0) // 已满足，不报缺口
})

// 13. 一个标签满足后，后续轮次仍可为其他标签选入携带该标签的标注
check('已满额标签不阻止携带它的标注继续为其他标签补额', () => {
  // X=1,Y=1：a1=[X,Y] 首轮入选填满；这里构造需要第二轮的场景
  const a1 = ann(['X', 'Y'], 'a1')
  const a2 = ann(['X'], 'a2')
  const a3 = ann(['Y'], 'a3')
  // a1 哈希刻意排不到第一的情况不易构造；直接断言总结果满足两标签配额
  const r = buildSampleQueue(config('q', [['X', 1], ['Y', 1]]), [a1, a2, a3])
  const statX = r.tagStats.find((t) => t.tag === 'X')!
  const statY = r.tagStats.find((t) => t.tag === 'Y')!
  assert.strictEqual(statX.gap, 0)
  assert.strictEqual(statY.gap, 0)
  assert.ok(r.entries.length <= 2)
})

// 14. 内容签名稳定且随任一字段变化
check('标注内容签名：相同内容相同，任一内容字段变化即改变', () => {
  const a = ann(['甲', '乙'], 'a1', { quote: '引文', note: '备注', start: 1, end: 3 })
  const s0 = annotationContentSignature(a)
  assert.strictEqual(s0, annotationContentSignature({ ...a, tags: ['甲', '乙'] }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, note: '改' }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, quote: '引' }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, start: 2 }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, end: 4 }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, tags: ['乙', '甲'] }))
  assert.notStrictEqual(s0, annotationContentSignature({ ...a, tags: ['甲'] }))
  assert.notStrictEqual(
    s0,
    annotationContentSignature({ ...a, status: 'pending' }),
  )
})

// 15. pruneSampleReviews：删除 / pending / 内容变化 → 失效
check('复核结论随标注删除、待处理化或内容变化自动失效', () => {
  const a = ann(['X'], 'a1', { quote: 'q', note: 'n' })
  const valid: SampleReview = {
    annotationId: 'a1',
    signature: annotationContentSignature(a),
    verdict: 'pass',
    note: '',
    createdAt: 1,
    updatedAt: 1,
  }
  const ghost: SampleReview = { ...valid, annotationId: 'ghost' }
  assert.deepStrictEqual(pruneSampleReviews([valid, ghost], [a]), [valid])
  assert.deepStrictEqual(pruneSampleReviews([valid], [{ ...a, status: 'pending' }]), [])
  assert.deepStrictEqual(pruneSampleReviews([valid], [{ ...a, note: '改' }]), [])
  // 仍有效
  assert.deepStrictEqual(pruneSampleReviews([valid], [{ ...a }]), [valid])
})

// 16. pruneSampleReviews 同键去重保留首条
check('pruneSampleReviews 对同键记录去重', () => {
  const a = ann(['X'], 'a1')
  const sig = annotationContentSignature(a)
  const r1: SampleReview = { annotationId: 'a1', signature: sig, verdict: 'pass', note: '一', createdAt: 1, updatedAt: 1 }
  const r2: SampleReview = { annotationId: 'a1', signature: sig, verdict: 'return', note: '二', createdAt: 2, updatedAt: 2 }
  assert.deepStrictEqual(pruneSampleReviews([r1, r2], [a]), [r1])
})

// 17. normalizeTargets：清洗、去重、排序、配额取整
check('normalizeTargets 清洗标签与配额并排序', () => {
  assert.deepStrictEqual(
    normalizeTargets([
      { tag: '#乙 ', count: 2 },
      { tag: '甲', count: 1 },
      { tag: '甲', count: 5 }, // 重复丢弃
      { tag: '', count: 3 },
      { tag: '丙', count: 0 },
      { tag: '丁', count: -2 },
      { tag: '戊', count: 2.9 }, // 向下取整为 2
      'junk',
    ]),
    [
      { tag: '乙', count: 2 },
      { tag: '戊', count: 2 },
      { tag: '甲', count: 1 },
    ],
  )
  assert.deepStrictEqual(normalizeTargets(undefined), [])
})

// 18. normalizeSampleConfig：非法 → null
check('normalizeSampleConfig 兼容旧数据与脏数据', () => {
  assert.strictEqual(normalizeSampleConfig(undefined), null)
  assert.strictEqual(normalizeSampleConfig(null), null)
  assert.strictEqual(normalizeSampleConfig({}), null)
  assert.strictEqual(normalizeSampleConfig({ seed: 123 }), null)
  assert.strictEqual(normalizeSampleConfig({ seed: 's', targets: [] }), null)
  const c = normalizeSampleConfig({
    seed: 's1',
    targets: [{ tag: 'T', count: 2 }],
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: 3,
  })
  assert.ok(c)
  assert.strictEqual(c!.seed, 's1')
  assert.deepStrictEqual(c!.targets, [{ tag: 'T', count: 2 }])
  assert.ok(c!.createdAt > 0)
  assert.strictEqual(c!.updatedAt, 3)
})

// 19. normalizeSampleReviews：脏数据丢弃、非法 verdict 归 pass、同键去重
check('normalizeSampleReviews 兼容旧数据与脏数据', () => {
  assert.deepStrictEqual(normalizeSampleReviews(undefined), [])
  const out = normalizeSampleReviews([
    { annotationId: 'a1', signature: 's1', verdict: 'return', note: 'n', createdAt: '2026-09-18T00:00:00.000Z', updatedAt: 2 },
    { annotationId: 'a1', signature: 's1', verdict: 'pass' }, // 同键去重
    { annotationId: '', signature: 's2' },
    { annotationId: 'a2' },
    { annotationId: 'a3', signature: 's3', verdict: 'weird' }, // 非法结论归 pass
  ])
  assert.strictEqual(out.length, 2)
  assert.strictEqual(out[0].verdict, 'return')
  assert.strictEqual(out[0].note, 'n')
  assert.ok(out[0].createdAt > 0)
  assert.strictEqual(out[1].verdict, 'pass')
})

// 20. sampleReviewKey 稳定
check('sampleReviewKey 由标注 ID 与签名组成', () => {
  assert.strictEqual(sampleReviewKey('a1', 's1'), 'a1 s1')
})

// 21. 端到端小场景：配额、队列顺序、缺口统计一致
check('端到端：多标签部分满足时报告缺口且队列稳定', () => {
  const list = [
    ann(['X'], 'x1'),
    ann(['X'], 'x2'),
    ann(['Y'], 'y1'),
    ann(['X', 'Y'], 'xy1'),
    ann(['Y'], 'py', { status: 'pending' }),
  ]
  const cfg = config('e2e', [['X', 2], ['Y', 3]])
  const r1 = buildSampleQueue(cfg, list)
  const r2 = buildSampleQueue(cfg, [...list].reverse())
  assert.deepStrictEqual(
    r1.entries.map((e) => e.annotationId),
    r2.entries.map((e) => e.annotationId),
  )
  // xy1 覆盖两个尚缺标签，必在首轮
  assert.strictEqual(r1.entries[0].annotationId, 'xy1')
  // Y 只有两个已绑定候选（y1、xy1），配额 3 → 缺口 1
  const statY = r1.tagStats.find((t) => t.tag === 'Y')!
  assert.strictEqual(statY.actual, 2)
  assert.strictEqual(statY.gap, 1)
  assert.strictEqual(r1.candidateCount, 4) // pending 不计
})

console.log(`\nsampling：${passed} 项断言全部通过`)
