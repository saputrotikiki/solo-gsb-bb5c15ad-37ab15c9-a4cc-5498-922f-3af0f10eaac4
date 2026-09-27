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

// 1. 旧位置 ±200 内精确匹配（前面插入文字，整体后移）
check('local-exact：附近插入文字后命中原位窗口', () => {
  const old = '子曰：学而时习之，不亦说乎？'
  const q = '学而时习之'
  const a = annAt(old, old.indexOf(q), old.indexOf(q) + q.length)
  const next = '这是新增的开头文字。' + old
  const r = findAnchor(next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.reason, 'local-exact')
    assert.strictEqual(next.slice(r.start, r.end), q)
  }
})

// 2. 窗口内有两处相同引文，但全文只有一处 —— 不可能；改为：移动超过 200，全文唯一
check('unique：引文被移动到 200 字窗口外，全文唯一命中', () => {
  const filler = '段'.repeat(250)
  const old = '开头。' + filler + '【目标锚】' + '尾巴'
  const a = annAt(old, old.indexOf('【目标锚】'), old.indexOf('【目标锚】') + 5)
  // 把前面删掉一大块，使新位置离开旧窗口超过 200，同时引文全文唯一
  const next = '【目标锚】' + '尾巴' + filler
  const r = findAnchor(next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.reason, 'unique')
    assert.strictEqual(r.start, 0)
  }
})

// 3. 评分：全文出现两次，靠上下文消歧
check('context-score：重复引文由前后文评分选出正确位置', () => {
  const old = '甲甲甲甲【相同引文】子丑寅卯辰巳午未申酉戌亥' + '另一处'.padEnd(60, '旁') + '【相同引文】' + '完全不同的后文啊啊啊啊啊啊'
  const target = '【相同引文】'
  const pos = old.indexOf(target)
  const a = annAt(old, pos, pos + target.length)
  // 插入打断，使原位窗口逻辑不稳：直接在 old 中间插入 250 字，把第二处推出窗口
  const next =
    old.slice(0, pos) + 'X'.repeat(250) + old.slice(pos)
  const r = findAnchor(next, a)
  assert.ok(r.ok, '应自动绑定')
  if (r.ok) {
    assert.strictEqual(r.reason, 'context-score')
    assert.ok(r.score > 0)
    // 正确位置应是带「子丑寅卯…」上下文的第一处（偏移 +250）
    assert.strictEqual(next.slice(r.start, r.end), target)
    assert.strictEqual(next.slice(r.end, r.end + 2), '子丑')
  }
})

// 4. 最高分并列 → 失败（tie）
check('tie：两处候选上下文相同字符数一致时不绑定', () => {
  const ctx = '上下文ABCD'
  const old =
    ctx + '【引文】' + ctx + '中间垃圾'.padEnd(40, '垃') + ctx + '【引文】' + ctx
  const pos = old.indexOf('【引文】')
  const a = annAt(old, pos, pos + 4)
  // 两处候选都落在旧位置 ±200 窗口内，且前后文字符数完全一致
  const next =
    ctx + '【引文】' + ctx + 'X'.repeat(50) + ctx + '【引文】' + ctx
  const r = findAnchor(next, a)
  assert.ok(!r.ok)
  if (!r.ok) assert.strictEqual(r.detail, 'tie')
})

// 5. 得分 0 → 失败（zero-score）
check('zero-score：只剩引文本体、上下文全变时不绑定', () => {
  const old = '原先上文AAAAAA【孤本】原先后文BBBBBB'
  const pos = old.indexOf('【孤本】')
  const a = annAt(old, pos, pos + 4)
  // 引文出现两次，周围都是与旧上下文无关的字符，且推出本地窗口
  const next = '〇'.repeat(250) + '圈圈【孤本】点点' + '~'.repeat(80) + '咕咕【孤本】唧唧'
  const r = findAnchor(next, a)
  assert.ok(!r.ok)
  if (!r.ok) assert.strictEqual(r.detail, 'zero-score')
})

// 6. 引文消失 → not-found
check('not-found：引文被删除时进入待处理', () => {
  const old = '天地玄黄【要删掉的引文】宇宙洪荒'
  const pos = old.indexOf('【要删掉的引文】')
  const a = annAt(old, pos, pos + 8)
  const r = findAnchor('天地玄黄宇宙洪荒', a)
  assert.ok(!r.ok)
  if (!r.ok) assert.strictEqual(r.detail, 'not-found')
})

// 7. contextScore 连续性：逐字符连续相同，不是字符集合计数
check('contextScore：只统计连续相同字符', () => {
  const text = '0123456789锚9876543210'
  // 候选「锚」位于 10，旧上文末尾 '789'，旧下文开头 '987'
  const s = contextScore(text, 10, 11, 'abc789', '987xyz')
  assert.strictEqual(s, 6)
  // 紧邻字符不符左侧立即计 0；右侧只连续到打断处
  const s2 = contextScore(text, 10, 11, 'bbb78X', '98X')
  assert.strictEqual(s2, 2)
})

// 8. 本地窗口内出现两处，且全文多处：走评分而不是直接失败
check('local-exact 窗口内多处时回退到评分', () => {
  const old = '独特上文ααα【重】独特下文βββ'
  const pos = old.indexOf('【重】')
  const a = annAt(old, pos, pos + 3)
  const next = '独特上文ααα【重】独特下文βββ' + '普通上文【重】普通下文'
  const r = findAnchor(next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.reason, 'context-score')
    assert.strictEqual(r.start, pos)
  }
})

// 9. 批量重定位 + 手动重新绑定
check('relocateAnnotations：失败置 pending，rebind 恢复 bound', () => {
  const old = '保留段【甲】保留段 删掉我【乙】'
  const a1 = annAt(old, old.indexOf('【甲】'), old.indexOf('【甲】') + 3)
  a1.id = 'a1'
  const a2 = annAt(old, old.indexOf('【乙】'), old.indexOf('【乙】') + 3)
  a2.id = 'a2'
  const nextText = '前缀'.repeat(20) + '保留段【甲】保留段 '
  const out = relocateAnnotations([a1, a2], nextText, 'fp')
  const b1 = out.find((x) => x.id === 'a1')!
  const b2 = out.find((x) => x.id === 'a2')!
  assert.strictEqual(b1.status, 'bound')
  assert.strictEqual(b2.status, 'pending')
  assert.ok(b2.pendingReason && b2.pendingReason.length > 0)
  const fixed = rebindAnnotation(b2, nextText + '新乙', nextText.length, nextText.length + 3)
  assert.strictEqual(fixed.status, 'bound')
  assert.strictEqual(fixed.quote, '新乙')
  assert.strictEqual(fixed.pendingReason, undefined)
})

// 10. 重叠出现也能枚举（"aaa" in "aaaaa" => 3 处）
check('findAllOccurrences：允许重叠匹配', () => {
  const a = annAt('aaa', 0, 3)
  const r = findAnchor('aaaaa', a)
  // 3 处候选，上下文全部为空/无关 → 0 分 → 失败而非误绑
  assert.ok(!r.ok)
})

console.log(`\n全部 ${passed} 项通过`)
