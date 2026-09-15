import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  parsePostMock,
  verifyHeaderCookieMock,
  findFirstMock,
  updateMock,
  updateManyMock,
  invalidateUserSessionMock
} = vi.hoisted(() => ({
  parsePostMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  findFirstMock: vi.fn(),
  updateMock: vi.fn(),
  updateManyMock: vi.fn(),
  invalidateUserSessionMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePostBody: parsePostMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      findFirst: findFirstMock,
      update: updateMock,
      updateMany: updateManyMock
    }
  }
}))

import { POST } from '~/app/api/user/setting/username/route'

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof POST
>[0]

beforeEach(() => {
  vi.clearAllMocks()
  parsePostMock.mockResolvedValue({ username: 'Kun' })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 42, name: 'OldName' })
  findFirstMock.mockResolvedValue(null)
  updateManyMock.mockResolvedValue({ count: 1 })
  invalidateUserSessionMock.mockResolvedValue(undefined)
})

describe('POST /api/user/setting/username', () => {
  it('charges through a conditional updateMany guarded by moemoepoint', async () => {
    const res = await POST(mockRequest)
    await expect(res.json()).resolves.toEqual({})

    // 守卫必须落在 WHERE 里: 退回读余额 + 应用层 if + 无条件 update 就是读后写竞态,
    // 并发改名会把余额扣成负数. name 守卫同样不能只留在应用层 —— 它兜的是
    // payload.name 陈旧时的重复扣分
    expect(updateMock).not.toHaveBeenCalled()
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 42, moemoepoint: { gte: 30 }, name: { not: 'Kun' } },
      data: { name: 'Kun', moemoepoint: { increment: -30 } }
    })
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(42)
  })

  it('treats a zero-row update as insufficient moemoepoint', async () => {
    updateManyMock.mockResolvedValue({ count: 0 })

    const res = await POST(mockRequest)
    await expect(res.json()).resolves.toBe(
      '更改用户名最少需要 30 萌萌点, 您的萌萌点不足'
    )

    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })

  // 原子性由 Postgres 提供, mock 证不了: 真实并发实测见
  // docs/tasks/username-rename-charge-cas.md. 这里只能证明路由把 count 当作唯一
  // 裁决依据 —— 输给 CAS 的请求一律不当作改名成功, 也不重复失效缓存
  it('renames only the caller whose conditional update matched a row', async () => {
    let balance = 30
    updateManyMock.mockImplementation(async () => {
      if (balance < 30) {
        return { count: 0 }
      }
      balance -= 30
      return { count: 1 }
    })

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => POST(mockRequest))
    )
    const bodies = await Promise.all(responses.map((res) => res.json()))

    expect(bodies.filter((body) => typeof body !== 'string')).toEqual([{}])
    expect(
      bodies.filter(
        (body) => body === '更改用户名最少需要 30 萌萌点, 您的萌萌点不足'
      )
    ).toHaveLength(7)
    expect(invalidateUserSessionMock).toHaveBeenCalledTimes(1)
  })

  it('rejects a name taken between the lookup and the update', async () => {
    updateManyMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test'
      })
    )

    const res = await POST(mockRequest)
    await expect(res.json()).resolves.toBe('您的用户名已经有人注册了, 请修改')

    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })

  it('does not swallow unrelated prisma errors', async () => {
    updateManyMock.mockRejectedValue(new Error('connection lost'))

    await expect(POST(mockRequest)).rejects.toThrow('connection lost')
  })

  it('rejects a taken name without touching the balance', async () => {
    findFirstMock.mockResolvedValue({ id: 7 })

    const res = await POST(mockRequest)
    await expect(res.json()).resolves.toBe('您的用户名已经有人注册了, 请修改')

    expect(updateManyMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })

  // 预检不排除自身时, ILIKE 命中的是调用者本人那一行, 只改大小写的改名恒被判成
  // 「已经有人注册」, 永远做不成. 这里按 where 是否带 id 过滤分流, 模拟库里除了
  // 自己没有别的同名用户
  it('lets a user change the case of their own name', async () => {
    parsePostMock.mockResolvedValue({ username: 'KUN' })
    verifyHeaderCookieMock.mockResolvedValue({ uid: 42, name: 'Kun' })
    findFirstMock.mockImplementation(
      (args: { where: { id?: { not: number } } }) =>
        Promise.resolve(args.where.id?.not === 42 ? null : { id: 42 })
    )

    const res = await POST(mockRequest)
    await expect(res.json()).resolves.toEqual({})

    expect(findFirstMock).toHaveBeenCalledWith({
      where: { name: { equals: 'KUN', mode: 'insensitive' }, id: { not: 42 } },
      select: { id: true }
    })
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 42, moemoepoint: { gte: 30 }, name: { not: 'KUN' } },
      data: { name: 'KUN', moemoepoint: { increment: -30 } }
    })
  })

  // 排除自身后就没人再挡「名字根本没变」的提交了, 不在扣费前拦住会白扣 30 萌萌点
  it('rejects an unchanged name before charging', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 42, name: 'Kun' })

    const res = await POST(mockRequest)
    await expect(res.json()).resolves.toBe('新用户名与当前用户名相同')

    expect(findFirstMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })
})
