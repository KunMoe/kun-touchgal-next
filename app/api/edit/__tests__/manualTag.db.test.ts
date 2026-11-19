import { randomUUID } from 'crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// 手动标签差量在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// 计数触发器的取锁、唯一索引上的等待、并发事务之间看不看得见对方的行, mock 都测不出来

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!dbContractUrl)('manual tag change on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let saveManualTagChange: typeof import('~/app/api/edit/batchTag').saveManualTagChange
  let userIds: number[] = []
  let tagBaseline = 0

  beforeAll(async () => {
    prisma = await openDbContract()
    ;({ saveManualTagChange } = await import('~/app/api/edit/batchTag'))
    const newest = await prisma.patch_tag.findFirst({
      orderBy: { id: 'desc' },
      select: { id: true }
    })
    tagBaseline = newest?.id ?? 0
  })

  afterEach(async () => {
    // patch 与关联随 user 级联; 标签的建立者只是置空, 按本文件建行之前的最大 id 清
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.patch_tag.deleteMany({ where: { id: { gt: tagBaseline } } })
    userIds = []
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  const newUser = async () => {
    const user = await prisma.user.create({
      data: {
        name: randomUUID().slice(0, 17),
        email: `${randomUUID()}@example.com`,
        password: 'x'
      }
    })
    userIds.push(user.id)
    return user
  }

  const newPatch = (userId: number) =>
    prisma.patch.create({
      data: {
        unique_id: randomUUID().slice(0, 8),
        name: 'manual tag contract',
        user_id: userId
      }
    })

  // 名字带随机段: patch_tag.name 全库唯一, 不与别的用例相撞
  const tagName = (label: string) => `t14-${randomUUID().slice(0, 8)}-${label}`

  const newTag = (name: string, alias: string[] = []) =>
    prisma.patch_tag.create({ data: { name, alias } })

  const relate = (patchId: number, tagIds: number[]) =>
    prisma.patch_tag_relation.createMany({
      data: tagIds.map((tagId) => ({ patch_id: patchId, tag_id: tagId }))
    })

  const relatedNames = async (patchId: number) =>
    (
      await prisma.patch_tag_relation.findMany({
        where: { patch_id: patchId },
        select: { tag: { select: { name: true } } },
        orderBy: { tag_id: 'asc' }
      })
    ).map((relation) => relation.tag.name)

  const countOf = async (tagId: number) =>
    (
      await prisma.patch_tag.findUnique({
        where: { id: tagId },
        select: { count: true }
      })
    )?.count

  const tagsNamed = (name: string) =>
    prisma.patch_tag.findMany({ where: { name } })

  it('按 id 移除、按名新增、别名解析到规范标签, 计数由触发器跟着变', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const alias = tagName('alias')
    const keep = await newTag(tagName('keep'))
    const drop = await newTag(tagName('drop'))
    const canonical = await newTag(tagName('canonical'), [alias])
    await relate(patch.id, [keep.id, drop.id])
    const brandNew = tagName('brand-new')

    const result = await saveManualTagChange(
      patch.id,
      { removeTagIds: [drop.id], addTagNames: [alias, brandNew] },
      user.id
    )

    expect(result).toEqual({ changed: true })
    expect(await relatedNames(patch.id)).toEqual([
      keep.name,
      canonical.name,
      brandNew
    ])
    // 输入别名不新建同名标签
    expect(await tagsNamed(alias)).toEqual([])
    const [created] = await tagsNamed(brandNew)
    expect(created).toMatchObject({
      source: 'self',
      user_id: user.id,
      count: 1
    })
    expect(await countOf(keep.id)).toBe(1)
    expect(await countOf(drop.id)).toBe(0)
    expect(await countOf(canonical.id)).toBe(1)
  })

  it('空差量不动任何关联; 列全现存标签的 id 即清空', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    // 名字里带逗号的标签按身份处理, 不会被拆开
    const first = await newTag(tagName('治愈，催泪'))
    const second = await newTag(tagName('b'))
    await relate(patch.id, [first.id, second.id])

    expect(
      await saveManualTagChange(
        patch.id,
        { removeTagIds: [], addTagNames: [] },
        user.id
      )
    ).toEqual({ changed: false })
    expect(await relatedNames(patch.id)).toEqual([first.name, second.name])

    expect(
      await saveManualTagChange(
        patch.id,
        { removeTagIds: [first.id, second.id], addTagNames: [] },
        user.id
      )
    ).toEqual({ changed: true })
    expect(await relatedNames(patch.id)).toEqual([])
    expect(await countOf(first.id)).toBe(0)
    expect(await countOf(second.id)).toBe(0)
  })

  it('移除只作用于这个 Galgame: 别的 Galgame 的关联、没关联的 id 都不受影响', async () => {
    const user = await newUser()
    const mine = await newPatch(user.id)
    const other = await newPatch(user.id)
    const shared = await newTag(tagName('shared'))
    const elsewhere = await newTag(tagName('elsewhere'))
    await relate(mine.id, [shared.id])
    await relate(other.id, [shared.id, elsewhere.id])

    const result = await saveManualTagChange(
      mine.id,
      { removeTagIds: [shared.id, elsewhere.id, 2147480000], addTagNames: [] },
      user.id
    )

    expect(result).toEqual({ changed: true })
    expect(await relatedNames(mine.id)).toEqual([])
    expect(await relatedNames(other.id)).toEqual([shared.name, elsewhere.name])
    expect(await countOf(shared.id)).toBe(1)
    expect(await countOf(elsewhere.id)).toBe(1)
  })

  it('用别名把正要移除的标签加回来: 关联保留, 计数不变', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const alias = tagName('alias')
    const canonical = await newTag(tagName('canonical'), [alias])
    await relate(patch.id, [canonical.id])

    const result = await saveManualTagChange(
      patch.id,
      { removeTagIds: [canonical.id], addTagNames: [alias] },
      user.id
    )

    expect(result).toEqual({ changed: false })
    expect(await relatedNames(patch.id)).toEqual([canonical.name])
    expect(await countOf(canonical.id)).toBe(1)
  })

  it('再次提交同一份差量是幂等的', async () => {
    const user = await newUser()
    const patch = await newPatch(user.id)
    const drop = await newTag(tagName('drop'))
    await relate(patch.id, [drop.id])
    const added = tagName('added')
    const change = { removeTagIds: [drop.id], addTagNames: [added] }

    expect(await saveManualTagChange(patch.id, change, user.id)).toEqual({
      changed: true
    })
    expect(await saveManualTagChange(patch.id, change, user.id)).toEqual({
      changed: false
    })

    expect(await relatedNames(patch.id)).toEqual([added])
    expect(await tagsNamed(added)).toHaveLength(1)
  })

  describe('并发', () => {
    const connect = async () => {
      const client = new pg.Client({ connectionString: dbContractUrl })
      await client.connect()
      return client
    }

    // 另一个事务已经插入了同名标签但还没提交: 解析时看不到它, 插入等在唯一索引上,
    // 对方提交之后跳过并回读到那一行。没有 skipDuplicates 的话这里是唯一约束违例
    it('新标签名被另一个尚未提交的事务抢先建好: 等它提交后关联到那一行', async () => {
      const user = await newUser()
      const patch = await newPatch(user.id)
      const name = tagName('raced')
      const other = await connect()
      try {
        await other.query('BEGIN')
        await other.query(
          `INSERT INTO patch_tag (name, alias, updated) VALUES ($1, '{}', now())`,
          [name]
        )

        let settled = false
        const pending = saveManualTagChange(
          patch.id,
          { removeTagIds: [], addTagNames: [name] },
          user.id
        ).finally(() => {
          settled = true
        })
        await sleep(300)
        // 对方没提交之前它只能等着
        expect(settled).toBe(false)
        await other.query('COMMIT')

        expect(await pending).toEqual({ changed: true })
      } finally {
        await other.query('ROLLBACK').catch(() => undefined)
        await other.end()
      }

      expect(await tagsNamed(name)).toHaveLength(1)
      expect(await relatedNames(patch.id)).toEqual([name])
      expect((await tagsNamed(name))[0].count).toBe(1)
    })

    it('两次保存同时引入同一批新标签名: 都成功, 每个名字只建一行', async () => {
      const user = await newUser()
      const [first, second] = [await newPatch(user.id), await newPatch(user.id)]

      for (let round = 0; round < 20; round++) {
        const names = [tagName(`r${round}-b`), tagName(`r${round}-a`)]
        // 两边给出的顺序相反: 不按名排序插入的话, 会各自等在对方的唯一索引条目上
        const results = await Promise.all([
          saveManualTagChange(
            first.id,
            { removeTagIds: [], addTagNames: names },
            user.id
          ),
          saveManualTagChange(
            second.id,
            { removeTagIds: [], addTagNames: [...names].reverse() },
            user.id
          )
        ])

        expect(results).toEqual([{ changed: true }, { changed: true }])
        for (const name of names) {
          const rows = await tagsNamed(name)
          expect(rows).toHaveLength(1)
          expect(rows[0].count).toBe(2)
        }
      }
    })

    // 同一个事务里先 INSERT 后 DELETE, 计数触发器在两条语句里分别取锁: A 把 x 换成 y、
    // B 把 y 换成 x 时, 没有事务开头的升序预锁就会互等 (40P01)
    it('两次保存反向换标签 20 轮都不死锁, 计数始终与关联一致', async () => {
      const user = await newUser()
      const [first, second] = [await newPatch(user.id), await newPatch(user.id)]
      const x = await newTag(tagName('x'))
      const y = await newTag(tagName('y'))
      await relate(first.id, [x.id])
      await relate(second.id, [y.id])

      let [firstHolds, secondHolds] = [x, y]
      for (let round = 0; round < 20; round++) {
        const results = await Promise.all([
          saveManualTagChange(
            first.id,
            { removeTagIds: [firstHolds.id], addTagNames: [secondHolds.name] },
            user.id
          ),
          saveManualTagChange(
            second.id,
            { removeTagIds: [secondHolds.id], addTagNames: [firstHolds.name] },
            user.id
          )
        ])
        expect(results).toEqual([{ changed: true }, { changed: true }])
        ;[firstHolds, secondHolds] = [secondHolds, firstHolds]

        expect(await relatedNames(first.id)).toEqual([firstHolds.name])
        expect(await relatedNames(second.id)).toEqual([secondHolds.name])
        expect(await countOf(x.id)).toBe(1)
        expect(await countOf(y.id)).toBe(1)
      }
    })
  })
})
