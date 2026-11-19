import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)

vi.mock('~/prisma/index', () => rec.module)

import { kunTx } from '~/server/db/tx'
import {
  applyManualTagChange,
  saveManualTagChange
} from '~/app/api/edit/batchTag'

const PATCH_ID = 1
const UID = 7
const LOCK_SQL =
  '$queryRaw: SELECT id FROM patch_tag WHERE id = ANY(?::int4[]) ORDER BY id FOR NO KEY UPDATE'

interface FakeTag {
  id: number
  name: string
  alias: string[]
}

// 解析新增名的查询带 OR (按名字或别名), 新建之后的回读只按名字
interface FindTagsArgs {
  where: {
    OR?: [{ name: { in: string[] } }, { alias: { hasSome: string[] } }]
    name?: { in: string[] }
  }
}

interface RelationFilterArgs {
  where: { patch_id: number; tag_id: { in: number[] } }
}

// 一个只有标签表与本 Galgame 关联集的内存库, 接在记录器的读写上: 用例既能断言语句与
// 顺序, 也能断言提交之后关联集变成了什么
const seed = (tags: FakeTag[], relatedIds: number[]) => {
  const state = {
    tags: tags.map((tag) => ({ ...tag })),
    related: new Set(relatedIds),
    nextId: 100
  }

  rec.on('patch_tag.findMany', (args: FindTagsArgs) => {
    if (args.where.OR) {
      const names = args.where.OR[0].name.in
      return state.tags
        .filter(
          (tag) =>
            names.includes(tag.name) ||
            tag.alias.some((alias) => names.includes(alias))
        )
        .sort((a, b) => a.id - b.id)
    }
    const names = args.where.name?.in ?? []
    return state.tags
      .filter((tag) => names.includes(tag.name))
      .map((tag) => ({ id: tag.id }))
  })
  rec.on('patch_tag_relation.findMany', (args: RelationFilterArgs) =>
    args.where.tag_id.in
      .filter((id) => state.related.has(id))
      .map((id) => ({ tag_id: id }))
  )
  rec.onRaw(/FOR NO KEY UPDATE/, [])
  rec.on('patch_tag.createMany', (args: { data: { name: string }[] }) => {
    let count = 0
    for (const row of args.data) {
      if (!state.tags.some((tag) => tag.name === row.name)) {
        state.tags.push({ id: state.nextId++, name: row.name, alias: [] })
        count++
      }
    }
    return { count }
  })
  rec.on(
    'patch_tag_relation.createMany',
    (args: { data: { tag_id: number }[] }) => {
      let count = 0
      for (const row of args.data) {
        if (!state.related.has(row.tag_id)) {
          state.related.add(row.tag_id)
          count++
        }
      }
      return { count }
    }
  )
  rec.on('patch_tag_relation.deleteMany', (args: RelationFilterArgs) => {
    let count = 0
    for (const id of args.where.tag_id.in) {
      if (state.related.delete(id)) {
        count++
      }
    }
    return { count }
  })

  return {
    state,
    relatedNames: () =>
      [...state.related]
        .sort((a, b) => a - b)
        .map((id) => state.tags.find((tag) => tag.id === id)?.name)
  }
}

beforeEach(() => {
  rec.reset()
})

describe('saveManualTagChange', () => {
  it('空差量不开事务, 不发任何语句', async () => {
    const result = await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: [] },
      UID
    )

    expect(result).toEqual({ changed: false })
    expect(rec.attempts).toHaveLength(0)
    expect(rec.outside).toHaveLength(0)
  })

  it('新增名规范化后为空时事务里不发任何语句', async () => {
    const result = await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: ['  ', ''] },
      UID
    )

    expect(result).toEqual({ changed: false })
    expect(rec.labels()).toEqual([])
  })

  it('读与写都在同一个事务里, 提交后以实际生效的行数报告 changed', async () => {
    const db = seed([{ id: 10, name: 'tag-old', alias: [] }], [10])

    const result = await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [10], addTagNames: ['brand-new'] },
      UID
    )

    expect(result).toEqual({ changed: true })
    expect(rec.outside).toHaveLength(0)
    expect(rec.attempts).toHaveLength(1)
    expect(rec.attempts[0].committed).toBe(true)
    expect(rec.attempts[0].options).toEqual({ timeout: 60000 })
    expect(db.relatedNames()).toEqual(['brand-new'])
  })

  it('没有任何行受影响时 changed 为 false', async () => {
    const db = seed([{ id: 10, name: '纯爱', alias: [] }], [10])

    // 新增一个已经关联着的标签, 移除一个本来就没关联的 id
    const result = await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [999], addTagNames: ['纯爱'] },
      UID
    )

    expect(result).toEqual({ changed: false })
    expect(db.relatedNames()).toEqual(['纯爱'])
  })

  it('事务里的语句抛错时回滚并原样抛出', async () => {
    seed([], [])
    rec.on('patch_tag.createMany', () => {
      throw new Error('connection lost')
    })

    await expect(
      saveManualTagChange(
        PATCH_ID,
        { removeTagIds: [], addTagNames: ['brand-new'] },
        UID
      )
    ).rejects.toThrow('connection lost')
    expect(rec.attempts[0].rolledBack).toBe(true)
  })
})

describe('applyManualTagChange 的新增名解析', () => {
  it('输入同时是 A 的别名与 B 的名字时按名字优先', async () => {
    const db = seed(
      [
        { id: 30, name: 'other', alias: ['X'] },
        { id: 31, name: 'X', alias: [] }
      ],
      []
    )

    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: ['X'] },
      UID
    )

    expect(rec.argsOf('patch_tag.createMany')).toEqual([])
    expect(db.relatedNames()).toEqual(['X'])
  })

  it('输入别名时只关联规范标签, 不新建同名标签', async () => {
    const db = seed([{ id: 20, name: '寝取られ', alias: ['NTR'] }], [])

    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: ['NTR'] },
      UID
    )

    expect(rec.argsOf('patch_tag.createMany')).toEqual([])
    expect(rec.argsOf('patch_tag_relation.createMany')).toEqual([
      { data: [{ patch_id: PATCH_ID, tag_id: 20 }], skipDuplicates: true }
    ])
    expect(db.state.tags).toHaveLength(1)
    expect(db.relatedNames()).toEqual(['寝取られ'])
  })

  it('名字与它的别名一起输入时只关联一次', async () => {
    const db = seed([{ id: 20, name: '寝取られ', alias: ['NTR'] }], [])

    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: ['寝取られ', 'NTR'] },
      UID
    )

    expect(rec.argsOf('patch_tag_relation.createMany')).toEqual([
      { data: [{ patch_id: PATCH_ID, tag_id: 20 }], skipDuplicates: true }
    ])
    expect(db.relatedNames()).toEqual(['寝取られ'])
  })
})

describe('applyManualTagChange 的删除集', () => {
  // 事务内先 INSERT 后 DELETE: 规范标签若留在删除集里, skipDuplicates 跳过插入之后
  // DELETE 会把它删掉
  it('用别名把正要移除的标签加回来时, 规范标签不进删除集', async () => {
    const db = seed([{ id: 10, name: '寝取られ', alias: ['NTR'] }], [10])

    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [10], addTagNames: ['NTR'] },
      UID
    )

    expect(rec.argsOf('patch_tag_relation.deleteMany')).toEqual([])
    expect(db.relatedNames()).toEqual(['寝取られ'])
  })

  it('不属于这个 Galgame 的 id 落空: 不加锁也不删', async () => {
    const db = seed(
      [
        { id: 10, name: 'mine', alias: [] },
        { id: 11, name: 'elsewhere', alias: [] }
      ],
      [10]
    )

    const result = await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [11, 404], addTagNames: [] },
      UID
    )

    expect(result).toEqual({ changed: false })
    expect(rec.labels()).toEqual(['patch_tag_relation.findMany'])
    expect(rec.argsOf('patch_tag_relation.findMany')).toEqual([
      {
        where: { patch_id: PATCH_ID, tag_id: { in: [11, 404] } },
        select: { tag_id: true }
      }
    ])
    expect(db.relatedNames()).toEqual(['mine'])
  })

  it('列全现存标签的 id 即清空', async () => {
    const db = seed(
      [
        { id: 10, name: 'a', alias: [] },
        { id: 11, name: 'b', alias: [] },
        { id: 12, name: 'c', alias: [] }
      ],
      [10, 11, 12]
    )

    const result = await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [12, 10, 11, 10], addTagNames: [] },
      UID
    )

    expect(result).toEqual({ changed: true })
    expect(db.relatedNames()).toEqual([])
  })
})

describe('applyManualTagChange 的加锁与写入顺序', () => {
  it('第一条取锁语句对「解析命中 ∪ 删除集」升序预加锁, 先于关系表的写入', async () => {
    seed(
      [
        { id: 50, name: 'tag-add', alias: [] },
        { id: 10, name: 'tag-old', alias: [] },
        { id: 30, name: 'tag-older', alias: [] }
      ],
      [30, 10]
    )

    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [30, 10], addTagNames: ['tag-add'] },
      UID
    )

    expect(rec.labels()).toEqual([
      'patch_tag.findMany',
      'patch_tag_relation.findMany',
      LOCK_SQL,
      'patch_tag_relation.createMany',
      'patch_tag_relation.deleteMany'
    ])
    // 拼接顺序为 [50, 30, 10], 断言升序排序生效
    expect(rec.argsOf(LOCK_SQL)).toEqual([[[10, 30, 50]]])
    expect(rec.argsOf('patch_tag_relation.deleteMany')).toEqual([
      { where: { patch_id: PATCH_ID, tag_id: { in: [30, 10] } } }
    ])
  })

  it('解析时没用上的候选标签不进锁集', async () => {
    seed(
      [
        { id: 30, name: 'other', alias: ['X'] },
        { id: 31, name: 'X', alias: [] }
      ],
      []
    )

    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: ['X'] },
      UID
    )

    expect(rec.argsOf(LOCK_SQL)).toEqual([[[31]]])
  })

  it('纯新建不预加锁; 新标签按名排序后一条语句插入, 带 skipDuplicates', async () => {
    const db = seed([], [])

    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: ['b', 'あ', 'a', 'B', 'b'] },
      UID
    )

    expect(rec.labels()).toEqual([
      'patch_tag.findMany',
      'patch_tag.createMany',
      'patch_tag.findMany',
      'patch_tag_relation.createMany'
    ])
    // 码元序: 大写在小写之前, 假名在拉丁字母之后
    expect(rec.argsOf('patch_tag.createMany')).toEqual([
      {
        data: ['B', 'a', 'b', 'あ'].map((name) => ({
          user_id: UID,
          name,
          source: 'self'
        })),
        skipDuplicates: true
      }
    ])
    expect(db.relatedNames()).toEqual(['B', 'a', 'b', 'あ'])
  })

  // 并发的另一次保存先一步建好了同名标签: 解析时还看不到, 插入被 skipDuplicates 跳过,
  // 回读拿到对方建的那一行
  it('新标签被并发建好时不报错, 关联到已存在的那一行', async () => {
    const db = seed([], [])
    rec.on('patch_tag.createMany', () => {
      db.state.tags.push({ id: 77, name: 'brand-new', alias: [] })
      return { count: 0 }
    })

    const result = await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: ['brand-new'] },
      UID
    )

    expect(result).toEqual({ changed: true })
    expect(rec.argsOf('patch_tag_relation.createMany')).toEqual([
      { data: [{ patch_id: PATCH_ID, tag_id: 77 }], skipDuplicates: true }
    ])
  })

  it('首参是调用方的事务客户端: 可以并进别人开的事务', async () => {
    const db = seed([{ id: 10, name: 'tag-old', alias: [] }], [10])

    const result = await kunTx('probe', ({ tx }) =>
      applyManualTagChange(
        tx,
        PATCH_ID,
        { removeTagIds: [10], addTagNames: [] },
        UID
      )
    )

    expect(result).toEqual({ changed: true })
    expect(rec.attempts).toHaveLength(1)
    expect(db.relatedNames()).toEqual([])
  })
})

// docs/tmp/carpet-review-2026-11-14/scratch/T14-judge/tagproto-probe.ts 的三个场景。
// 表单打开时读到的现存标签: A(1)、X(2)、「治愈，催泪」(3)
describe('差量协议在陈旧基线下的行为', () => {
  it('S1 表单打开之后 X 被删、A 改名为 B、别人加了 C: 原样提交不改任何关联', async () => {
    const db = seed(
      [
        { id: 1, name: 'B', alias: [] },
        { id: 3, name: '治愈，催泪', alias: [] },
        { id: 4, name: 'C', alias: [] }
      ],
      [1, 3, 4]
    )

    const result = await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: [] },
      UID
    )

    expect(result).toEqual({ changed: false })
    expect(db.relatedNames()).toEqual(['B', '治愈，催泪', 'C'])
    expect(db.state.tags).toHaveLength(3)
  })

  it('S1 基线里已被别人解除的标签再点移除: 不动别人新增的 C', async () => {
    const db = seed(
      [
        { id: 1, name: 'B', alias: [] },
        { id: 3, name: '治愈，催泪', alias: [] },
        { id: 4, name: 'C', alias: [] }
      ],
      [1, 3, 4]
    )

    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [2], addTagNames: [] },
      UID
    )

    expect(db.relatedNames()).toEqual(['B', '治愈，催泪', 'C'])
  })

  it('S2 追加一个标签: 名字里带逗号的现存标签原样保留, 只新建追加的那一个', async () => {
    const db = seed(
      [
        { id: 1, name: 'A', alias: [] },
        { id: 2, name: 'X', alias: [] },
        { id: 3, name: '治愈，催泪', alias: [] }
      ],
      [1, 2, 3]
    )

    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: ['新标签'] },
      UID
    )

    expect(rec.argsOf('patch_tag.createMany')).toEqual([
      {
        data: [{ user_id: UID, name: '新标签', source: 'self' }],
        skipDuplicates: true
      }
    ])
    expect(rec.argsOf('patch_tag_relation.deleteMany')).toEqual([])
    expect(db.relatedNames()).toEqual(['A', 'X', '治愈，催泪', '新标签'])
  })

  it('S3 清空与不动是两个不同的请求', async () => {
    const tags = [
      { id: 1, name: 'A', alias: [] },
      { id: 2, name: 'X', alias: [] },
      { id: 3, name: '治愈，催泪', alias: [] }
    ]

    const untouched = seed(tags, [1, 2, 3])
    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [], addTagNames: [] },
      UID
    )
    expect(untouched.relatedNames()).toEqual(['A', 'X', '治愈，催泪'])

    rec.reset()
    const cleared = seed(tags, [1, 2, 3])
    await saveManualTagChange(
      PATCH_ID,
      { removeTagIds: [1, 2, 3], addTagNames: [] },
      UID
    )
    expect(cleared.relatedNames()).toEqual([])
  })
})
