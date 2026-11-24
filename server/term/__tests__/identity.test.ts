import { describe, expect, it, vi } from 'vitest'
import {
  companyTerms,
  createTerms,
  findTermConflict,
  pickTermForName,
  readTermIds,
  resolveExistingTerms,
  tagTerms,
  type TermRef
} from '~/server/term/identity'
import type { Prisma } from '~/prisma/generated/prisma/client'

const term = (id: number, name: string, alias: string[] = []): TermRef => ({
  id,
  name,
  alias
})

describe('pickTermForName', () => {
  it('名字精确匹配优先于别名, 即使别名那条 id 更小', () => {
    const candidates = [term(1, 'other', ['x']), term(9, 'x')]
    expect(pickTermForName('x', candidates, { matchAlias: true })?.id).toBe(9)
  })

  it('名字区分大小写: 只差大小写的名字不算名字命中', () => {
    expect(
      pickTermForName('key', [term(1, 'Key')], { matchAlias: true })
    ).toBeUndefined()
  })

  it('带大写的输入命中规范形别名, 存量的大小写混合别名按原串仍能命中', () => {
    expect(
      pickTermForName(' NTR ', [term(3, '寝取られ', ['ntr'])], {
        matchAlias: true
      })?.id
    ).toBe(3)
    expect(
      pickTermForName('NTR', [term(4, '寝取られ', ['NTR'])], {
        matchAlias: true
      })?.id
    ).toBe(4)
  })

  it('多条按别名命中时取 id 最小的一条, 与候选的顺序无关', () => {
    const candidates = [term(40, 'b', ['dup']), term(12, 'a', ['dup'])]
    expect(pickTermForName('dup', candidates, { matchAlias: true })?.id).toBe(
      12
    )
  })

  it('matchAlias: false 时只认名字', () => {
    expect(
      pickTermForName('ntr', [term(3, '寝取られ', ['ntr'])], {
        matchAlias: false
      })
    ).toBeUndefined()
  })
})

// 只有 patch_tag / patch_company 两个委托的假客户端, 记下每条调用的参数
const fakeDb = () => {
  const calls: { op: string; args: unknown }[] = []
  const delegate = (table: string) => ({
    findMany: vi.fn(async (args: unknown) => {
      calls.push({ op: `${table}.findMany`, args })
      return []
    }),
    findFirst: vi.fn(async (args: unknown): Promise<TermRef | null> => {
      calls.push({ op: `${table}.findFirst`, args })
      return null
    }),
    createMany: vi.fn(async (args: unknown) => {
      calls.push({ op: `${table}.createMany`, args })
      return { count: 0 }
    })
  })
  const db = {
    patch_tag: delegate('patch_tag'),
    patch_company: delegate('patch_company')
  }
  return { db, calls, tx: db as unknown as Prisma.TransactionClient }
}

describe('resolveExistingTerms / createTerms / readTermIds', () => {
  it('空输入不发语句', async () => {
    const { tx, calls } = fakeDb()
    await resolveExistingTerms(tx, tagTerms, [], { matchAlias: true })
    await createTerms(tx, tagTerms, [], (name) => ({ name, user_id: 1 }))
    await readTermIds(tx, tagTerms, [])
    expect(calls).toEqual([])
  })

  it('不按别名找时条件里没有别名子句', async () => {
    const { tx, calls } = fakeDb()
    await resolveExistingTerms(tx, tagTerms, ['A'], { matchAlias: false })
    expect(calls[0].args).toEqual({
      where: { name: { in: ['A'] } },
      select: { id: true, name: true, alias: true },
      orderBy: { id: 'asc' }
    })
  })

  it('新建按码元序一条语句插入, 带 skipDuplicates', async () => {
    const { tx, calls } = fakeDb()
    await createTerms(tx, companyTerms, ['b', 'あ', 'B'], (name) => ({
      name,
      user_id: 1
    }))
    expect(calls).toEqual([
      {
        op: 'patch_company.createMany',
        args: {
          data: ['B', 'b', 'あ'].map((name) => ({ name, user_id: 1 })),
          skipDuplicates: true
        }
      }
    ])
  })
})

describe('findTermConflict', () => {
  it('新名字对他人的名字与别名查重, 编辑时排除自己', async () => {
    const { db, tx } = fakeDb()
    db.patch_tag.findFirst.mockResolvedValueOnce(term(2, 'ADV'))

    await expect(
      findTermConflict(tx, tagTerms, {
        name: 'ADV',
        addedAliases: [],
        selfId: 1
      })
    ).resolves.toBe('这个标签已经存在了')
    expect(db.patch_tag.findFirst.mock.calls[0][0]).toMatchObject({
      where: {
        id: { not: 1 },
        OR: [{ name: { in: ['ADV'] } }, { alias: { hasSome: ['ADV', 'adv'] } }]
      }
    })
  })

  it('新加的别名撞上他人的名字或别名时指明是哪一个', async () => {
    const { db, tx } = fakeDb()
    db.patch_company.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(term(5, 'Navel', ['ナベール']))

    await expect(
      findTermConflict(tx, companyTerms, {
        name: 'Key',
        addedAliases: ['key', 'ナベール']
      })
    ).resolves.toBe('别名「ナベール」已是会社「Navel」的名字或别名')
    expect(db.patch_company.findFirst.mock.calls[1][0]).toMatchObject({
      where: {
        OR: [
          { name: { in: ['key', 'ナベール'] } },
          { alias: { hasSome: ['key', 'ナベール'] } }
        ]
      }
    })
  })

  it('没有新加的别名时只查一次', async () => {
    const { db, tx } = fakeDb()
    await expect(
      findTermConflict(tx, tagTerms, { name: 'ADV', addedAliases: [] })
    ).resolves.toBeNull()
    expect(db.patch_tag.findFirst).toHaveBeenCalledTimes(1)
  })
})
