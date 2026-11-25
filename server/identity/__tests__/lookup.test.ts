import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  answerLowerLookup,
  parseLowerLookup
} from '~/server/identity/__tests__/support/lowerLookup'

const { queryRawMock, findUniqueMock } = vi.hoisted(() => ({
  queryRawMock: vi.fn(),
  findUniqueMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: { $queryRaw: queryRawMock, user: { findUnique: findUniqueMock } }
}))

import {
  findUserByEmailForReset,
  findUserForLogin,
  isEmailTaken,
  isUsernameTaken
} from '~/server/identity/lookup'

// 模拟库: 原生查询只按被查的那一列匹配 (大小写不敏感), 按主键取整行。
// 用例因此钉的是「查哪一列、绑定什么」, 不是调用次数
const rows = [
  // 邮箱的真正持有者
  { id: 1, name: 'victim', email: 'Victim@QQ.com' },
  // 把用户名改成了别人邮箱的账号 (改名规则收紧之前的存量)
  { id: 2, name: 'victim@qq.com', email: 'attacker@qq.com' },
  // 邮箱形态的用户名, 而这个邮箱没有人注册 (生产统计为 0 的那类存量)
  { id: 3, name: 'lonely@qq.com', email: 'lonely-real@qq.com' }
]

beforeEach(() => {
  queryRawMock.mockReset()
  queryRawMock.mockImplementation(async (query: unknown) =>
    answerLowerLookup(rows, query)
  )
  findUniqueMock.mockReset()
  findUniqueMock.mockImplementation(
    async (args: { where: { id: number }; select?: object }) =>
      rows.find((row) => row.id === args.where.id) ?? null
  )
})

const lookups = () =>
  queryRawMock.mock.calls.map(([query]) => parseLowerLookup(query))

describe('findUserForLogin', () => {
  // P07-02 / X07-03: 以前一条 OR 同时查两列且不排序, 两行里随机取一行
  it('邮箱持有者与邮箱形态的用户名同时存在时, 取邮箱持有者', async () => {
    const user = await findUserForLogin({ kind: 'email', raw: 'victim@qq.com' })
    expect(user).toMatchObject({ id: 1 })
    expect(lookups().map(({ column }) => column)).toEqual(['email'])
    // 登录要校验密码: 显式取回全局 omit 隐藏的 password
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 1 },
      omit: { password: false }
    })
  })

  it('没有人持有这个邮箱时不回落到 name 列, 邮箱形态的用户名登不进去', async () => {
    const user = await findUserForLogin({ kind: 'email', raw: 'lonely@qq.com' })
    expect(user).toBeNull()
    expect(lookups().map(({ column }) => column)).toEqual(['email'])
    expect(findUniqueMock).not.toHaveBeenCalled()
  })

  it('用户名形态的输入只查 name 列, 从不查 email', async () => {
    const user = await findUserForLogin({ kind: 'name', raw: 'VICTIM' })
    expect(user).toMatchObject({ id: 1 })
    expect(lookups().map(({ column }) => column)).toEqual(['name'])
  })

  it('查不到时返回 null', async () => {
    await expect(
      findUserForLogin({ kind: 'email', raw: 'nobody@qq.com' })
    ).resolves.toBeNull()
    await expect(
      findUserForLogin({ kind: 'name', raw: 'nobody' })
    ).resolves.toBeNull()
  })

  // 等号两侧是字面比较: 转义了反而查不到带 _ 或 % 的账号; 预先小写会与库里的 lower() 分叉
  it('输入原样绑定, 不转义通配符也不预先小写, 不排除任何人', async () => {
    await findUserForLogin({ kind: 'email', raw: 'Kun_Chan@qq.com' })
    await findUserForLogin({ kind: 'name', raw: 'kun_chan%' })
    expect(lookups()).toEqual([
      { column: 'email', value: 'Kun_Chan@qq.com', exceptUid: null },
      { column: 'name', value: 'kun_chan%', exceptUid: null }
    ])
  })
})

describe('isUsernameTaken / isEmailTaken', () => {
  it('exceptUid 为 null 时不排除任何人', async () => {
    await expect(isUsernameTaken('VICTIM', { exceptUid: null })).resolves.toBe(
      true
    )
    await expect(
      isEmailTaken('victim@QQ.COM', { exceptUid: null })
    ).resolves.toBe(true)
    expect(lookups()).toEqual([
      { column: 'name', value: 'VICTIM', exceptUid: null },
      { column: 'email', value: 'victim@QQ.COM', exceptUid: null }
    ])
    // 查重只要 id, 不取整行
    expect(findUniqueMock).not.toHaveBeenCalled()
  })

  // #62: 只改自己名字或邮箱的大小写时不算被占用
  it('排除给定的 uid', async () => {
    await expect(isUsernameTaken('VICTIM', { exceptUid: 1 })).resolves.toBe(
      false
    )
    expect(lookups()).toEqual([
      { column: 'name', value: 'VICTIM', exceptUid: 1 }
    ])

    await expect(isEmailTaken('VICTIM@qq.com', { exceptUid: 1 })).resolves.toBe(
      false
    )
    await expect(isEmailTaken('VICTIM@qq.com', { exceptUid: 2 })).resolves.toBe(
      true
    )
  })
})

describe('findUserByEmailForReset', () => {
  it('按邮箱大小写不敏感地找人, 只查 email 列, 只取 id 与库里存的邮箱', async () => {
    await expect(
      findUserByEmailForReset('VICTIM@qq.com')
    ).resolves.toMatchObject({ id: 1 })
    expect(lookups()).toEqual([
      { column: 'email', value: 'VICTIM@qq.com', exceptUid: null }
    ])
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { id: true, email: true }
    })
  })

  it('查不到时返回 null, 不再按主键取', async () => {
    await expect(findUserByEmailForReset('nobody@qq.com')).resolves.toBeNull()
    expect(findUniqueMock).not.toHaveBeenCalled()
  })
})
