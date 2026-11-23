import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findFirstMock } = vi.hoisted(() => ({ findFirstMock: vi.fn() }))

vi.mock('~/prisma/index', () => ({
  prisma: { user: { findFirst: findFirstMock } }
}))

import {
  findUserByEmailForReset,
  findUserForLogin,
  insensitiveEquals,
  isEmailTaken,
  isUsernameTaken
} from '~/server/identity/lookup'

type Where = {
  email?: { equals: string; mode: string }
  name?: { equals: string; mode: string }
  id?: { not: number }
}

// 按 where 里的列分流, 模拟库: 只按被查的那一列匹配 (大小写不敏感)。
// 用例因此钉的是「查哪一列、按什么顺序」, 不是调用次数
const rows = [
  // 邮箱的真正持有者
  { id: 1, name: 'victim', email: 'Victim@QQ.com' },
  // 把用户名改成了别人邮箱的账号 (改名规则收紧之前的存量)
  { id: 2, name: 'victim@qq.com', email: 'attacker@qq.com' },
  // 邮箱形态的用户名, 而这个邮箱没有人注册 (生产统计为 0 的那类存量)
  { id: 3, name: 'lonely@qq.com', email: 'lonely-real@qq.com' }
]

const unescape = (value: string) => value.replace(/\\([\\%_])/g, '$1')

const matching = (where: Where) =>
  rows.filter((row) => {
    if (where.id && row.id === where.id.not) {
      return false
    }
    const [column, filter] = where.email
      ? (['email', where.email] as const)
      : (['name', where.name!] as const)
    return row[column].toLowerCase() === unescape(filter.equals).toLowerCase()
  })

beforeEach(() => {
  findFirstMock.mockReset()
  findFirstMock.mockImplementation(async (args: { where: Where }) => {
    const [row] = matching(args.where)
    return row ?? null
  })
})

const queriedColumns = () =>
  findFirstMock.mock.calls.map(([args]) =>
    (args as { where: Where }).where.email ? 'email' : 'name'
  )

describe('insensitiveEquals', () => {
  it('转义 LIKE 通配符与转义符本身, 让它们按字面匹配', () => {
    expect(insensitiveEquals('a_c%\\d')).toEqual({
      equals: 'a\\_c\\%\\\\d',
      mode: 'insensitive'
    })
  })

  it('普通值原样通过, 不预先小写', () => {
    expect(insensitiveEquals('Tester@Example.com')).toEqual({
      equals: 'Tester@Example.com',
      mode: 'insensitive'
    })
  })
})

describe('findUserForLogin', () => {
  // P07-02 / X07-03: 以前一条 OR 同时查两列且不排序, 两行里随机取一行
  it('邮箱持有者与邮箱形态的用户名同时存在时, 取邮箱持有者', async () => {
    const user = await findUserForLogin({ kind: 'email', raw: 'victim@qq.com' })
    expect(user).toMatchObject({ id: 1 })
    expect(queriedColumns()).toEqual(['email'])
  })

  it('没有人持有这个邮箱时不回落到 name 列, 邮箱形态的用户名登不进去', async () => {
    const user = await findUserForLogin({ kind: 'email', raw: 'lonely@qq.com' })
    expect(user).toBeNull()
    expect(queriedColumns()).toEqual(['email'])
  })

  it('用户名形态的输入只查 name 列, 从不查 email', async () => {
    const user = await findUserForLogin({ kind: 'name', raw: 'VICTIM' })
    expect(user).toMatchObject({ id: 1 })
    expect(queriedColumns()).toEqual(['name'])
  })

  it('两列都查不到时返回 null', async () => {
    await expect(
      findUserForLogin({ kind: 'email', raw: 'nobody@qq.com' })
    ).resolves.toBeNull()
    await expect(
      findUserForLogin({ kind: 'name', raw: 'nobody' })
    ).resolves.toBeNull()
  })

  it('查询是转义过的大小写不敏感精确匹配, 不带 orderBy (带了会改走主键索引逐行回表)', async () => {
    await findUserForLogin({ kind: 'email', raw: 'kun_chan@qq.com' })
    await findUserForLogin({ kind: 'name', raw: 'kun_chan%' })
    expect(findFirstMock.mock.calls).toEqual([
      [
        {
          where: { email: { equals: 'kun\\_chan@qq.com', mode: 'insensitive' } }
        }
      ],
      [{ where: { name: { equals: 'kun\\_chan\\%', mode: 'insensitive' } } }]
    ])
  })
})

describe('isUsernameTaken / isEmailTaken', () => {
  it('exceptUid 为 null 时不排除任何人', async () => {
    await expect(isUsernameTaken('VICTIM', { exceptUid: null })).resolves.toBe(
      true
    )
    expect(findFirstMock).toHaveBeenLastCalledWith({
      where: { name: { equals: 'VICTIM', mode: 'insensitive' } },
      select: { id: true }
    })

    await expect(
      isEmailTaken('victim@QQ.COM', { exceptUid: null })
    ).resolves.toBe(true)
    expect(findFirstMock).toHaveBeenLastCalledWith({
      where: { email: { equals: 'victim@QQ.COM', mode: 'insensitive' } },
      select: { id: true }
    })
  })

  // #62: 只改自己名字或邮箱的大小写时不算被占用
  it('排除给定的 uid', async () => {
    await expect(isUsernameTaken('VICTIM', { exceptUid: 1 })).resolves.toBe(
      false
    )
    expect(findFirstMock).toHaveBeenLastCalledWith({
      where: {
        name: { equals: 'VICTIM', mode: 'insensitive' },
        id: { not: 1 }
      },
      select: { id: true }
    })

    await expect(isEmailTaken('VICTIM@qq.com', { exceptUid: 1 })).resolves.toBe(
      false
    )
    await expect(isEmailTaken('VICTIM@qq.com', { exceptUid: 2 })).resolves.toBe(
      true
    )
  })

  it('通配符按字面匹配', async () => {
    await expect(isUsernameTaken('vict_m', { exceptUid: null })).resolves.toBe(
      false
    )
    expect(findFirstMock).toHaveBeenLastCalledWith({
      where: { name: { equals: 'vict\\_m', mode: 'insensitive' } },
      select: { id: true }
    })
  })
})

describe('findUserByEmailForReset', () => {
  it('按邮箱大小写不敏感地找人, 只查 email 列', async () => {
    await expect(
      findUserByEmailForReset('VICTIM@qq.com')
    ).resolves.toMatchObject({ id: 1 })
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { email: { equals: 'VICTIM@qq.com', mode: 'insensitive' } },
      select: { id: true, email: true }
    })
  })
})
