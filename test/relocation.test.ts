import assert from 'node:assert'
import {
  findAnchor,
  contextScore,
  rebindAnnotation,
  relocateAnnotations,
  makeContext,
} from '../src/lib/relocation'
import type { Annotation } from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

// 构造一条绑在 [start,end) 的标注
function annAt(text: string, start: number, end: number): Annotation {
  const ctx = makeContext(text, start, end)
  return {
    id: 'x',
    quote: text.slice(start, end),
    start,
    end,
    note: '',
    tags: [],
    status: 'bound',
    createdAt: 0,
    updatedAt: 0,
    contextBefore: ctx.before,
    contextAfter: ctx.after,
  }
}

// 1. 仅前方插入文字：原区间仍在，位置自动后移
check('identity-continue：前方插入文字后自动平移', () => {
  const old = '子曰：学而时习之，不亦说乎？'
  const q = '学而时习之'
  const a = annAt(old, old.indexOf(q), old.indexOf(q) + q.length)
  const next = '这是新增的开头文字。' + old
  const r = findAnchor(old, next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.reason, 'identity-continue')
    assert.strictEqual(next.slice(r.start, r.end), q)
    assert.strictEqual(r.start, old.indexOf(q) + '这是新增的开头文字。'.length)
  }
})

// 2. 仅前方删除文字：原区间仍在，位置自动前移
check('identity-continue：前方删除文字后自动平移', () => {
  const insert = '这是新增的开头文字。'
  const old = insert + '子曰：学而时习之'
  const q = '学而时习之'
  const a = annAt(old, old.indexOf(q), old.indexOf(q) + q.length)
  const next = '子曰：学而时习之'
  const r = findAnchor(old, next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.reason, 'identity-continue')
    assert.strictEqual(r.start, next.indexOf(q))
  }
})

// 3. 仅后方插删：原区间位置不变
check('identity-continue：仅在引文后方编辑时位置不变', () => {
  const old = '【目标锚】旧尾巴'.repeat(0) + '前文【目标锚】旧尾巴'
  const pos = old.indexOf('【目标锚】')
  const a = annAt(old, pos, pos + 5)
  const next = '前文【目标锚】' + '新增一大段尾巴。'.repeat(20)
  const r = findAnchor(old, next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.reason, 'identity-continue')
    assert.strictEqual(r.start, pos)
  }
})

// 4. 核心缺陷回归：同一引文相距不足 200 字出现两处，删除「已标注的那处」时，
//    不允许把标注静默绑到剩余副本 —— 即使剩余副本在旧位置 200 字窗口内、即使它是局部唯一命中
check('identity-deleted：删掉已标注副本，近距同文副本不得静默接管', () => {
  const q = '【相同引文】'
  const old = '前文甲' + q + '子丑寅卯辰巳午未申酉戌亥' + q + '结尾'
  const pos = old.indexOf(q) // 标注第一处
  const a = annAt(old, pos, pos + q.length)
  // 两处相距不足 200 字；删除第一处（连同其独有上下文），只剩第二处副本
  const next = '前文甲' + '子丑寅卯辰巳午未申酉戌亥' + q + '结尾'
  assert.ok(Math.abs(next.indexOf(q) - pos) < 200, '副本应落在旧版 200 字局部窗口内')
  const r = findAnchor(old, next, a)
  assert.ok(!r.ok, '不得自动绑定到剩余副本')
  // 逐字符对齐中，原引文段已不属于任何最优对齐 → 确认删除；现存文字只是同文副本
  if (!r.ok) assert.strictEqual(r.detail, 'identity-deleted')
})

// 5. 对称情形：删除的是未标注的另一处副本，原标注区间不受影响
check('identity-continue：删掉未标注副本时原标注继续有效', () => {
  const q = '【相同引文】'
  const old = '前文甲' + q + '子丑寅卯辰巳午未申酉戌亥' + q + '结尾'
  const pos = old.indexOf(q)
  const a = annAt(old, pos, pos + q.length)
  const second = old.indexOf(q, pos + 1)
  const next = old.slice(0, second) + old.slice(second + q.length)
  const r = findAnchor(old, next, a)
  assert.ok(r.ok, '原片段仍在，应自动确认')
  if (r.ok) {
    assert.strictEqual(r.reason, 'identity-continue')
    assert.strictEqual(r.start, pos)
    assert.strictEqual(next.slice(r.start, r.end), q)
  }
})

// 6. 编辑后无法区分保留的是哪一份同文片段 → 身份存疑，待处理
check('identity-ambiguous：紧邻同文片段删改导致两种对齐时不绑定', () => {
  // 旧文为相邻两份 'ab'（标注占满前一份 [0,2)），新文只剩一份。
  // LCS 下保留前一份（删掉后一份）与不保留前一份同样最优 → 身份无法确认
  const old = 'abab'
  const a = annAt(old, 0, 2)
  const r = findAnchor(old, 'ab', a)
  assert.ok(!r.ok)
  if (!r.ok) assert.strictEqual(r.detail, 'identity-ambiguous')
})

// 7. 引文连同所有副本一起消失 → not-found
check('not-found：引文被完全删除时进入待处理', () => {
  const old = '天地玄黄【要删掉的引文】宇宙洪荒'
  const pos = old.indexOf('【要删掉的引文】')
  const a = annAt(old, pos, pos + 8)
  const r = findAnchor(old, '天地玄黄宇宙洪荒', a)
  assert.ok(!r.ok)
  if (!r.ok) assert.strictEqual(r.detail, 'not-found')
})

// 8. 大段重排：引文虽在但原片段身份无法由对齐确认 → 待处理（不再靠「全文唯一」猜绑）
check('identity-deleted：内容大段搬移、原片段不被最优对齐保留时不绑定', () => {
  const filler = '段'.repeat(250)
  const old = '开头。' + filler + '【目标锚】' + '尾巴'
  const pos = old.indexOf('【目标锚】')
  const a = annAt(old, pos, pos + 5)
  // 把前方 250 字整块搬到引文后面：引文虽全文唯一，但这是重排而非「仅前方插删」
  const next = '【目标锚】' + '尾巴' + filler
  const r = findAnchor(old, next, a)
  assert.ok(!r.ok, '重排无法确认原区间延续，应进入待处理')
  if (!r.ok) assert.ok(r.detail === 'identity-deleted' || r.detail === 'identity-ambiguous')
})

// 9. contextScore 连续性（旧启发式仅保留为工具函数）：逐字符连续相同，不是字符集合计数
check('contextScore：只统计连续相同字符', () => {
  const text = '0123456789锚9876543210'
  const s = contextScore(text, 10, 11, 'abc789', '987xyz')
  assert.strictEqual(s, 6)
  const s2 = contextScore(text, 10, 11, 'bbb78X', '98X')
  assert.strictEqual(s2, 2)
})

// 10. 原文未改但区间已对不上引文：不擅自绑定
check('原文未变但区间失效：identity-ambiguous 不绑定', () => {
  const a = annAt('aaa', 0, 3)
  const r = findAnchor('aaa', 'aaa', { ...a, start: 0, end: 2, quote: 'aaa' })
  assert.ok(!r.ok)
})

// 11. 批量重定位：自动平移 / 误绑保护 / 手动重新绑定恢复
check('relocateAnnotations：原片段延续则平移，被删则 pending，rebind 可恢复', () => {
  const old = '保留段【甲】保留段 删掉我【乙】'
  const a1 = annAt(old, old.indexOf('【甲】'), old.indexOf('【甲】') + 3)
  a1.id = 'a1'
  const a2 = annAt(old, old.indexOf('【乙】'), old.indexOf('【乙】') + 3)
  a2.id = 'a2'
  const prefix = '前缀'.repeat(20)
  const nextText = prefix + '保留段【甲】保留段 '
  const out = relocateAnnotations([a1, a2], old, nextText, 'fp')
  const b1 = out.find((x) => x.id === 'a1')!
  const b2 = out.find((x) => x.id === 'a2')!
  assert.strictEqual(b1.status, 'bound')
  assert.strictEqual(b1.start, nextText.indexOf('【甲】'))
  assert.strictEqual(b1.lastRelocation?.reason, 'identity-continue')
  assert.strictEqual(b2.status, 'pending')
  assert.ok(b2.pendingReason && b2.pendingReason.length > 0)
  assert.strictEqual(b2.lastRelocation?.reason, 'failed')
  // 手动重绑仍可恢复
  const fixed = rebindAnnotation(b2, nextText + '新乙', nextText.length, nextText.length + 2)
  assert.strictEqual(fixed.status, 'bound')
  assert.strictEqual(fixed.quote, '新乙')
  assert.strictEqual(fixed.pendingReason, undefined)
})

// 12. 近距双副本回归（批量口径）：删第一处后 pending，删第二处后 bound
check('relocateAnnotations：近距同文副本的删除方向决定绑定/待处理', () => {
  const q = '【相同引文】'
  const old = '前文' + q + '甲乙丙丁戊己庚辛壬癸' + q + '尾巴'
  const pos = old.indexOf(q)
  const a = annAt(old, pos, pos + q.length)
  a.id = 'dup'

  const deletedFirst = '前文' + '甲乙丙丁戊己庚辛壬癸' + q + '尾巴'
  const r1 = relocateAnnotations([a], old, deletedFirst, 'fp')[0]
  assert.strictEqual(r1.status, 'pending')
  assert.ok(r1.pendingReason!.includes('副本'))

  const second = old.indexOf(q, pos + 1)
  const deletedSecond = old.slice(0, second) + old.slice(second + q.length)
  const r2 = relocateAnnotations([a], old, deletedSecond, 'fp')[0]
  assert.strictEqual(r2.status, 'bound')
  assert.strictEqual(r2.start, pos)
})

// 12b. issue 最小复现：单字引文两处相距仅 10 字，删除已标注处，剩余唯一命中不得接管
check('最小复现：相距 10 字的同文单字，删已标注处不静默误绑', () => {
  const old = '01234锚一二三四五六七八九锚尾'
  const pos = old.indexOf('锚')
  const a = annAt(old, pos, pos + 1)
  const next = '01234一二三四五六七八九锚尾'
  const r1 = findAnchor(old, next, a)
  assert.ok(!r1.ok && r1.detail === 'identity-deleted')

  // 反向：删未标注的第二处，原标注不动
  const p2 = old.indexOf('锚', pos + 1)
  const kept = old.slice(0, p2) + old.slice(p2 + 1)
  const r2 = findAnchor(old, kept, a)
  assert.ok(r2.ok && r2.start === pos)
})

// 13. 改动范围过大（超过对齐开销上限）→ 待处理并说明，不做任何猜测式绑定
check('edit-too-large：超大规模编辑进入待处理', () => {
  const q = '【锚】'
  const old = 'X'.repeat(1000) + q + 'Y'.repeat(1000)
  // 首字符被替换：公共前缀为 0；末尾又被加入不同字符使公共后缀也为 0，
  // 迫使约 2003×2004 规模的对齐（超过 400 万上限）
  const next = 'Z' + old.slice(1) + 'Q'
  const pos = old.indexOf(q)
  const a = annAt(old, pos, pos + q.length)
  const r = findAnchor(old, next, a)
  assert.ok(!r.ok)
  if (!r.ok) assert.strictEqual(r.detail, 'edit-too-large')
})

console.log(`\n全部 ${passed} 项通过`)
