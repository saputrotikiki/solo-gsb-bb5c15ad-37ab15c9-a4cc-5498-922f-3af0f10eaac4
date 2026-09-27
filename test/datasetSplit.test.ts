import assert from 'node:assert'
import { createHash } from 'node:crypto'
import {
  buildDatasetJsonl,
  buildOverlapGroups,
  formatPercent,
  groupHash,
  parsePercents,
  splitDatasets,
} from '../src/lib/datasetSplit'
import type { Annotation } from '../src/types'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
}

let seq = 0
function ann(
  id: string,
  start: number,
  end: number,
  opts: Partial<Annotation> = {},
): Annotation {
  seq += 1
  return {
    id,
    quote: `q${seq}`,
    start,
    end,
    note: '',
    tags: [],
    status: 'bound',
    createdAt: 0,
    updatedAt: 0,
    contextBefore: '',
    contextAfter: '',
    ...opts,
  }
}

const groupIds = (groups: Annotation[][]) =>
  groups.map((g) => g.map((a) => a.id).sort()).sort((x, y) => x.join().localeCompare(y.join()))

// 1. 百分比校验
check('parsePercents：合计 100 的非负整数通过', () => {
  const r = parsePercents({ train: '80', validation: '10', test: '10' })
  assert.ok(r.ok)
  if (r.ok) assert.deepStrictEqual(r.percents, { train: 80, validation: 10, test: 10 })
  // 允许空白
  const r2 = parsePercents({ train: ' 70 ', validation: '20', test: '10' })
  assert.ok(r2.ok)
  // 允许 0
  const r3 = parsePercents({ train: '100', validation: '0', test: '0' })
  assert.ok(r3.ok)
})

check('parsePercents：空值 / 小数 / 越界 / 合计不为 100 均拒绝', () => {
  assert.strictEqual(parsePercents({ train: '', validation: '50', test: '50' }).ok, false)
  assert.strictEqual(parsePercents({ train: '80.5', validation: '10', test: '9.5' }).ok, false)
  assert.strictEqual(parsePercents({ train: '-1', validation: '51', test: '50' }).ok, false)
  assert.strictEqual(parsePercents({ train: '101', validation: '0', test: '-1' }).ok, false)
  const sum = parsePercents({ train: '80', validation: '10', test: '5' })
  assert.strictEqual(sum.ok, false)
  if (!sum.ok) assert.ok(sum.error.includes('100'))
})

// 2. 连通分组
check('区间字符交集 → 同组；端点相接不合并；传递关系合并', () => {
  // a[0,3) b[2,5) 交 [2,3)；d[4,6) 与 b 交 [4,5)、与 c[5,8) 交 [5,6)
  // → a-b-d-c 传递闭包为同一组；e[10,12) 独立
  const list = [
    ann('a', 0, 3),
    ann('b', 2, 5),
    ann('c', 5, 8),
    ann('d', 4, 6),
    ann('e', 10, 12),
  ]
  const groups = groupIds(buildOverlapGroups(list))
  assert.deepStrictEqual(groups, [['a', 'b', 'c', 'd'], ['e']])
})

check('半开区间端点相接（[0,5) 与 [5,10)）不算交集', () => {
  const groups = groupIds(buildOverlapGroups([ann('x', 0, 5), ann('y', 5, 10)]))
  assert.deepStrictEqual(groups, [['x'], ['y']])
})

check('空区间标注各自成组，不与任何区间合并', () => {
  const groups = groupIds(
    buildOverlapGroups([ann('z', 7, 7), ann('w', 3, 3), ann('a', 0, 10)]),
  )
  assert.deepStrictEqual(groups, [['a'], ['w'], ['z']])
})

check('待处理标注不参与分组', () => {
  const groups = buildOverlapGroups([
    ann('p', 0, 10, { status: 'pending' }),
    ann('b', 1, 2),
  ])
  assert.deepStrictEqual(groupIds(groups), [['b']])
})

check('分组结果与传入顺序无关', () => {
  const list = [ann('a', 0, 3), ann('b', 2, 5), ann('c', 5, 8), ann('d', 4, 6), ann('e', 10, 12)]
  const g1 = groupIds(buildOverlapGroups(list))
  const g2 = groupIds(buildOverlapGroups([...list].reverse()))
  assert.deepStrictEqual(g1, g2)
})

// 3. 组哈希
check('groupHash = SHA-256(种子 + 组内 ID 排序后拼接)', () => {
  const ids = ['id_b', 'id_a']
  const expected = createHash('sha256').update('seed1' + 'id_aid_b').digest('hex')
  assert.strictEqual(groupHash('seed1', ids), expected)
  // 输入乱序不影响哈希
  assert.strictEqual(groupHash('seed1', ['id_a', 'id_b']), expected)
  assert.notStrictEqual(groupHash('seed2', ['id_a', 'id_b']), expected)
})

// 4. 划分：无已绑定标注
check('无已绑定标注时统计全零且 JSONL 为空字符串', () => {
  const r = splitDatasets(
    [ann('p', 0, 2, { status: 'pending' })],
    { train: 80, validation: 10, test: 10 },
    's',
  )
  assert.strictEqual(r.totalGroups, 0)
  assert.strictEqual(r.totalAnnotations, 0)
  assert.strictEqual(r.excludedPending, 1)
  for (const name of ['train', 'validation', 'test'] as const) {
    assert.strictEqual(r.stats[name].groupCount, 0)
    assert.strictEqual(buildDatasetJsonl(r, '标题', '原文', name), '')
  }
})

// 5. 划分：80/10/10 下 10 组 → 8/1/1（组数口径），决胜顺序 train→validation→test
check('贪心配额：10 个独立组、80/10/10 → 训练 8 / 验证 1 / 测试 1', () => {
  const list = Array.from({ length: 10 }, (_, i) => ann(`g${i}`, i * 3, i * 3 + 1))
  const r = splitDatasets(list, { train: 80, validation: 10, test: 10 }, 's')
  assert.strictEqual(r.totalGroups, 10)
  assert.strictEqual(r.stats.train.groupCount, 8)
  assert.strictEqual(r.stats.validation.groupCount, 1)
  assert.strictEqual(r.stats.test.groupCount, 1)
  // 第一个组在全 0 缺口并列时进入 train，随后 validation、test
  assert.strictEqual(r.assigned[0].dataset, 'train')
  assert.strictEqual(r.assigned[1].dataset, 'validation')
  assert.strictEqual(r.assigned[2].dataset, 'test')
})

check('目标为 0 的集合永不入选（50/50/0 → 5/5/0）', () => {
  const list = Array.from({ length: 10 }, (_, i) => ann(`g${i}`, i * 3, i * 3 + 1))
  const r = splitDatasets(list, { train: 50, validation: 50, test: 0 }, 's')
  assert.strictEqual(r.stats.train.groupCount, 5)
  assert.strictEqual(r.stats.validation.groupCount, 5)
  assert.strictEqual(r.stats.test.groupCount, 0)
  assert.ok(r.assigned.every((x) => x.dataset !== 'test'))
})

check('0/0/100 → 全部进入测试集', () => {
  const list = [ann('a', 0, 1), ann('b', 2, 3)]
  const r = splitDatasets(list, { train: 0, validation: 0, test: 100 }, 's')
  assert.strictEqual(r.stats.test.groupCount, 2)
})

// 6. 连通组绝不拆分
check('有字符交集的标注整组进入同一集合（含传递链）', () => {
  // 构造 6 个组：一条长传递链 + 5 个独立组
  const list = [
    ann('chain_a', 0, 3),
    ann('chain_b', 2, 5),
    ann('chain_c', 4, 7),
    ann('solo1', 20, 21),
    ann('solo2', 30, 31),
    ann('solo3', 40, 41),
    ann('solo4', 50, 51),
    ann('solo5', 60, 61),
  ]
  const r = splitDatasets(list, { train: 80, validation: 10, test: 10 }, 'k')
  const chainGroup = r.assigned.find((x) =>
    x.group.annotationIds.includes('chain_a'),
  )!
  assert.deepStrictEqual(chainGroup.group.annotationIds, [
    'chain_a',
    'chain_b',
    'chain_c',
  ])
  // 链上三条标注统计在同一集合的标注数里
  assert.strictEqual(r.stats[chainGroup.dataset].annotationCount >= 3, true)
  // 全部组的标注都只落在自己被分到的集合
  for (const item of r.assigned) {
    for (const name of ['train', 'validation', 'test'] as const) {
      const inJsonl = buildDatasetJsonl(r, 't', 'x', name)
      for (const id of item.group.annotationIds) {
        const lines = inJsonl.split('\n').filter(Boolean)
        const appears = lines.filter((line) => line.includes(`"id":"${id}"`)).length
        assert.strictEqual(
          appears,
          name === item.dataset ? 1 : 0,
          `标注 ${id} 只能出现在 ${item.dataset} 的导出中`,
        )
      }
    }
  }
})

// 7. 确定性
check('相同种子与百分比 + 相同标注集（乱序输入）→ 完全相同的划分', () => {
  const list = [
    ann('a', 0, 3),
    ann('b', 2, 5),
    ann('c', 5, 8),
    ann('d', 4, 6),
    ann('e', 10, 12),
    ann('f', 20, 22),
  ]
  const p = { train: 60, validation: 25, test: 15 }
  const sig = (r: ReturnType<typeof splitDatasets>) =>
    r.assigned.map((x) => `${x.dataset}:${x.group.annotationIds.join('|')}`).join('\n')
  const r1 = splitDatasets(list, p, 'stable-seed')
  const r2 = splitDatasets([...list].reverse(), p, 'stable-seed')
  assert.strictEqual(sig(r1), sig(r2))
  // assigned 已按组哈希字典序排列
  const hashes = r1.assigned.map((x) => x.group.hash)
  const sortedHashes = [...hashes].sort()
  assert.deepStrictEqual(hashes, sortedHashes)
  // 换种子可能改变划分（至少哈希不同）
  const r3 = splitDatasets(list, p, 'other-seed')
  assert.notDeepStrictEqual(
    r3.assigned.map((x) => x.group.hash),
    r1.assigned.map((x) => x.group.hash),
  )
})

// 8. 统计与排除数
check('各集合组数、标注数、实际占比与待处理排除数正确', () => {
  // 组 1：两条标注；组 2、3：各一条；外加 2 条 pending
  const list = [
    ann('m1', 0, 5, { tags: ['甲'] }),
    ann('m2', 4, 9, { tags: ['乙'] }),
    ann('s1', 20, 21),
    ann('s2', 30, 31),
    ann('p1', 40, 41, { status: 'pending' }),
    ann('p2', 50, 51, { status: 'pending' }),
  ]
  const r = splitDatasets(list, { train: 34, validation: 33, test: 33 }, 's')
  assert.strictEqual(r.totalGroups, 3)
  assert.strictEqual(r.totalAnnotations, 4)
  assert.strictEqual(r.excludedPending, 2)
  const sumGroups =
    r.stats.train.groupCount + r.stats.validation.groupCount + r.stats.test.groupCount
  const sumAnns =
    r.stats.train.annotationCount +
    r.stats.validation.annotationCount +
    r.stats.test.annotationCount
  assert.strictEqual(sumGroups, 3)
  assert.strictEqual(sumAnns, 4)
  const annPctSum =
    r.stats.train.annotationPercent +
    r.stats.validation.annotationPercent +
    r.stats.test.annotationPercent
  assert.ok(Math.abs(annPctSum - 100) < 1e-9)
  // 双标注组的集合标注数为 2、组数为 1
  const doubled = r.assigned.find((x) => x.group.annotationIds.includes('m1'))!
  assert.strictEqual(r.stats[doubled.dataset].annotationCount >= 2, true)
})

// 9. JSONL 结构
check('JSONL：每组一行，含标题、原文、集合名及组内 ID/区间/引文/标签/备注', () => {
  const list = [
    ann('j1', 0, 2, { quote: '引文一', tags: ['标签A', '标签B'], note: '备注一' }),
    ann('j2', 5, 7, { quote: '引文二', tags: [], note: '' }),
  ]
  const r = splitDatasets(list, { train: 100, validation: 0, test: 0 }, 'js')
  const jsonl = buildDatasetJsonl(r, '我的文档', '这是全文', 'train')
  const lines = jsonl.split('\n').filter(Boolean)
  assert.strictEqual(lines.length, 2)
  for (const line of lines) {
    const row = JSON.parse(line)
    assert.strictEqual(row.title, '我的文档')
    assert.strictEqual(row.text, '这是全文')
    assert.strictEqual(row.dataset, 'train')
    assert.ok(Array.isArray(row.group.annotationIds))
    const a = row.group.annotations[0]
    assert.ok(typeof a.id === 'string')
    assert.ok(typeof a.position.start === 'number' && typeof a.position.end === 'number')
    assert.ok('quote' in a && 'tags' in a && 'note' in a)
  }
  const first = JSON.parse(lines[0])
  assert.deepStrictEqual(first.group.annotations[0].tags, ['标签A', '标签B'])
  assert.strictEqual(first.group.annotations[0].note, '备注一')
  assert.strictEqual(first.group.annotations[0].position.end, 2)
  // 三个文件行数之和 = 组数；验证集 / 测试集为空
  assert.strictEqual(buildDatasetJsonl(r, 't', 'x', 'validation'), '')
  assert.strictEqual(buildDatasetJsonl(r, 't', 'x', 'test'), '')
})

// 10. formatPercent
check('formatPercent：至多一位小数并去掉多余的 0', () => {
  assert.strictEqual(formatPercent(0), '0')
  assert.strictEqual(formatPercent(100), '100')
  assert.strictEqual(formatPercent(33.3333), '33.3')
  assert.strictEqual(formatPercent(66.6666), '66.7')
  assert.strictEqual(formatPercent(50.04), '50')
})

console.log(`\ndatasetSplit：${passed} 项断言全部通过`)
