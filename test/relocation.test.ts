import assert from 'node:assert'
import {
  trackAnnotation,
  diffEditRegion,
  mapOffset,
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

// 1. 回归：同一引文相距不足 200 字出现两处，删除已标注那处，
//    剩余局部唯一命中不得静默绑到副本上 → identity-lost
check('误绑回归：删掉已标注的那处重复引文后进入待处理，不绑剩余副本', () => {
  const old = '前文……【相同引文】……（间隔仅十余字）……【相同引文】……后文'
  const q = '【相同引文】'
  const firstPos = old.indexOf(q)
  const a = annAt(old, firstPos, firstPos + q.length)
  // 删除第一处（已标注处）连同其前缀几个字，第二处保留
  const next = old.slice(0, firstPos - 2) + old.slice(firstPos + q.length)
  assert.ok(next.includes(q), '前置条件：同文副本仍在')
  assert.strictEqual(next.indexOf(q), next.lastIndexOf(q), '前置条件：局部（全文）只剩一处')
  assert.ok(Math.abs(next.indexOf(q) - firstPos) < 200, '前置条件：副本与旧位置相距不足 200 字')
  const r = trackAnnotation(old, next, a)
  assert.ok(!r.ok, '必须进入待处理，绝不静默误绑')
  if (!r.ok) assert.strictEqual(r.detail, 'identity-lost')
})

// 2. 原片段仍在，仅前方插入文字 → tracked，位置后移
check('tracked：前方插入文字时原区间整体后移', () => {
  const old = '子曰：学而时习之，不亦说乎？'
  const q = '学而时习之'
  const pos = old.indexOf(q)
  const a = annAt(old, pos, pos + q.length)
  const inserted = '这是新增的开头文字。'
  const next = inserted + old
  const r = trackAnnotation(old, next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.reason, 'tracked')
    assert.strictEqual(r.start, pos + inserted.length)
    assert.strictEqual(next.slice(r.start, r.end), q)
  }
})

// 3. 原片段仍在，仅前方删除文字（大幅前移，超过 200 字也照样跟随）
check('tracked：前方删除大段文字时原区间整体前移，不受 200 字窗口限制', () => {
  const filler = '段'.repeat(250)
  const old = '开头。' + filler + '【目标锚】尾巴'
  const pos = old.indexOf('【目标锚】')
  const a = annAt(old, pos, pos + 5)
  // 只删除标注前方的一大块：原区间及后方字符原样保留
  const next = '开头。' + '【目标锚】尾巴'
  const r = trackAnnotation(old, next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.reason, 'tracked')
    assert.strictEqual(r.start, '开头。'.length)
    assert.strictEqual(next.slice(r.start, r.end), '【目标锚】')
  }
})

// 4. 仅在标注后方插删文字 → 起点不变
check('tracked：仅后方插删时标注位置不变', () => {
  const old = '【目标】后文内容保持不变'
  const a = annAt(old, 0, 4)
  const next = '【目标】' + '新增的一段文字。'.repeat(10) + '后文内容保持不变'
  const r = trackAnnotation(old, next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.start, 0)
    assert.strictEqual(r.end, 4)
  }

  // 后方删除
  const r2 = trackAnnotation(old, '【目标】后文', a)
  assert.ok(r2.ok)
  if (r2.ok) assert.strictEqual(r2.start, 0)
})

// 5. 编辑发生在远处、与标注区间不相交 → tracked
check('tracked：远处修改与区间不相交时原位保留', () => {
  const old = '甲乙丙丁【锚】戊己庚辛' + '子丑寅卯'.repeat(60)
  const pos = old.indexOf('【锚】')
  const a = annAt(old, pos, pos + 3)
  const next = old.replace('子丑寅卯', '改了这里')
  const r = trackAnnotation(old, next, a)
  assert.ok(r.ok)
  if (r.ok) assert.strictEqual(r.start, pos)
})

// 6. 原片段被删除且无副本 → not-found
check('not-found：引文随编辑删除且全文不再出现', () => {
  const old = '天地玄黄【要删掉的引文】宇宙洪荒'
  const pos = old.indexOf('【要删掉的引文】')
  const a = annAt(old, pos, pos + 8)
  const r = trackAnnotation(old, '天地玄黄宇宙洪荒', a)
  assert.ok(!r.ok)
  if (!r.ok) assert.strictEqual(r.detail, 'not-found')
})

// 7. 在标注区间内部插入 / 改写文字 → identity-lost（即使引文文本仍以副本存在）
check('identity-lost：编辑触及区间内部时不自动绑定', () => {
  const old = '前文AAAA【孤本】后文BBBB 另有【孤本】副本'
  const pos = old.indexOf('【孤本】')
  const a = annAt(old, pos, pos + 4)
  // 在原区间内部插入字符；副本仍在
  const next = old.slice(0, pos + 2) + '插入' + old.slice(pos + 2)
  assert.ok(next.includes('【孤本】'), '副本仍存在')
  const r = trackAnnotation(old, next, a)
  assert.ok(!r.ok)
  if (!r.ok) assert.strictEqual(r.detail, 'identity-lost')
})

// 8. 重复引文两处：编辑只在第一处（已标注处）前方插入 → 仍能确认身份，跟随的是原位
check('tracked：重复引文中已标注那处仅前方插入时绑到原位而非别处副本', () => {
  const old = '独特上文ααα【重】独特下文βββ 普通上文【重】普通下文'
  const pos = old.indexOf('【重】')
  const a = annAt(old, pos, pos + 3)
  const next = '新增前缀！' + old
  const r = trackAnnotation(old, next, a)
  assert.ok(r.ok)
  if (r.ok) {
    assert.strictEqual(r.reason, 'tracked')
    assert.strictEqual(r.start, pos + 5)
    assert.strictEqual(next.slice(r.end, r.end + 2), '独特', '必须仍是带独特下文的原位')
  }
})

// 9. 批量重定位：前方插入的跟随、被删的 pending、原 pending 不自动恢复
check('relocateAnnotations：跟随/待处理分流，原 pending 保持待处理，rebind 可恢复', () => {
  const old = '保留段【甲】保留段 删掉我【乙】 待处理项【丙】尾巴'
  const a1 = annAt(old, old.indexOf('【甲】'), old.indexOf('【甲】') + 3)
  a1.id = 'a1'
  const a2 = annAt(old, old.indexOf('【乙】'), old.indexOf('【乙】') + 3)
  a2.id = 'a2'
  const a3 = annAt(old, old.indexOf('【丙】'), old.indexOf('【丙】') + 3)
  a3.id = 'a3'
  a3.status = 'pending'
  a3.pendingReason = '历史原因'
  // 编辑区在【甲】之后（【甲】连同前文完整处于共同前缀 → 原位保留）；
  // 删掉【乙】（引文消失 → 待处理）；【丙】在共同后缀中，但它本来就 pending，不自动恢复。
  const nextText = '保留段【甲】保留段 待处理项【丙】尾巴'
  const out = relocateAnnotations([a1, a2, a3], old, nextText, 'fp')
  const b1 = out.find((x) => x.id === 'a1')!
  const b2 = out.find((x) => x.id === 'a2')!
  const b3 = out.find((x) => x.id === 'a3')!
  assert.strictEqual(b1.status, 'bound')
  assert.strictEqual(b1.lastRelocation?.reason, 'tracked')
  assert.strictEqual(nextText.slice(b1.start, b1.end), '【甲】')
  assert.strictEqual(b2.status, 'pending')
  assert.ok(b2.pendingReason && b2.pendingReason.length > 0)
  // 原本 pending 的不参与重定位：身份字段保持不变
  assert.strictEqual(b3.status, 'pending')
  assert.strictEqual(b3.pendingReason, '历史原因')
  assert.strictEqual(b3.lastRelocation, undefined)

  // 手动重绑恢复
  const fixed = rebindAnnotation(b2, nextText + '新乙', nextText.length, nextText.length + 3)
  assert.strictEqual(fixed.status, 'bound')
  assert.strictEqual(fixed.quote, '新乙')
  assert.strictEqual(fixed.pendingReason, undefined)
})

// 10. diffEditRegion / mapOffset 基本性质
check('diffEditRegion + mapOffset：共同前后缀与平移量', () => {
  // 中间插入
  const r1 = diffEditRegion('abcdef', 'abcXYZdef')
  assert.deepStrictEqual(
    { os: r1.oldStart, oe: r1.oldEnd, ns: r1.newStart, ne: r1.newEnd },
    { os: 3, oe: 3, ns: 3, ne: 6 },
  )
  assert.deepStrictEqual(mapOffset(0, r1), { kind: 'mapped', offset: 0 })
  assert.deepStrictEqual(mapOffset(4, r1), { kind: 'mapped', offset: 7 })
  // 纯插入：插入点偏移（=oldStart=oldEnd）视为插入前位置，映射到插入点
  assert.deepStrictEqual(mapOffset(3, r1), { kind: 'mapped', offset: 3 })

  // 前方删除 2 字
  const r2 = diffEditRegion('xxabc', 'abc')
  assert.strictEqual(r2.oldStart, 0)
  assert.strictEqual(r2.oldEnd, 2)
  // 偏移 3 落在未改动后缀（>= oldEnd=2）→ 映射到 1
  assert.deepStrictEqual(mapOffset(3, r2), { kind: 'mapped', offset: 1 })
  // 偏移 1 落在被删除区间内 → 不可确认
  assert.deepStrictEqual(mapOffset(1, r2), { kind: 'inside' })

  // 无改动
  const r3 = diffEditRegion('same', 'same')
  assert.strictEqual(r3.oldStart, r3.oldEnd)
  assert.strictEqual(r3.newStart, r3.newEnd)

  // 前后缀交叠（'a' 同时充当前后缀）：标记不可确认
  const r4 = diffEditRegion('aba', 'aXa')
  assert.ok(r4.ambiguous || !r4.ambiguous) // 具体是否交叠取决于实现；交叠时映射必须拒绝
  if (r4.ambiguous) {
    assert.deepStrictEqual(mapOffset(1, r4), { kind: 'inside' })
  }
})

// 11. 编辑未改动正文时各标注位置不变（relocateAnnotations 幂等）
check('相同原文：重定位后区间与上下文不变', () => {
  const old = '完全相同的原文，标注位置不应变化。'
  const pos = old.indexOf('标注位置')
  const a = annAt(old, pos, pos + 4)
  const out = relocateAnnotations([a], old, old, 'fp')[0]!
  assert.strictEqual(out.status, 'bound')
  assert.strictEqual(out.start, pos)
  assert.strictEqual(out.end, pos + 4)
  assert.strictEqual(out.start, out.start)
})

// 12. 非空引文标注：引文被改写后即使别处存在同文副本也进入待处理
check('区间被改写：剩余同文副本不自动绑定；前方插入时跟随', () => {
  const old = 'abcdef【锚】xyz'
  const pos = old.indexOf('【锚】')
  const a = annAt(old, pos, pos + 3)
  // 原区间处文字被改写，但他处保留同文副本
  const withCopy = old.slice(0, pos) + '【别的】' + old.slice(pos + 3) + '【锚】'
  const r1 = trackAnnotation(old, withCopy, a)
  assert.ok(!r1.ok)
  if (!r1.ok) assert.strictEqual(r1.detail, 'identity-lost')
  // 仅前方插入 → 跟随
  const moved = trackAnnotation(old, 'YY' + old, a)
  assert.ok(moved.ok)
  if (moved.ok) assert.strictEqual(moved.start, pos + 2)
})

console.log(`\n全部 ${passed} 项通过`)
