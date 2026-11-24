import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// 走真实的 kunRoute 与解析器: 小数 uid 必须在边界就被拒。放行的话, 守卫拿 5.5 与会话 uid 5
// 比较不相等, Prisma 落库时又把 5.5 截成 5, 写出自关注行与发给自己的通知 (P08-01)

const { verifyHeaderCookieMock, prismaAccess } = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  prismaAccess: [] as string[]
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// 校验没拦住的请求一定会碰库: 记下每一次访问
vi.mock('~/prisma/index', () => ({
  prisma: new Proxy(
    {},
    {
      get: (_, key) => {
        prismaAccess.push(String(key))
        throw new Error(`不应访问 prisma.${String(key)}`)
      }
    }
  )
}))

import { POST as followRoute } from '~/app/api/user/follow/follow/route'
import { POST as unfollowRoute } from '~/app/api/user/follow/unfollow/route'
import { GET as floatingRoute } from '~/app/api/user/profile/floating/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/user/follow', {
    method: 'POST',
    body: JSON.stringify(body)
  })

beforeEach(() => {
  vi.resetAllMocks()
  prismaAccess.length = 0
  verifyHeaderCookieMock.mockResolvedValue({ uid: 5, role: 1, name: 'kun' })
})

describe('关注 / 取消关注 / 悬浮卡片的 uid 必须是整数', () => {
  it.each([
    ['关注', followRoute],
    ['取消关注', unfollowRoute]
  ])('%s: 会话 uid + 0.5 被拒, 不碰库', async (_, route) => {
    const res = await route(post({ uid: 5.5 }))

    expect(await res.json()).toBe('用户 ID 无效')
    expect(prismaAccess).toEqual([])
  })

  it('关注: 整数的自身 uid 由守卫拦下', async () => {
    const res = await followRoute(post({ uid: 5 }))

    expect(await res.json()).toBe('您不能关注自己')
    expect(prismaAccess).toEqual([])
  })

  it('悬浮卡片: 小数 uid 被拒', async () => {
    const res = await floatingRoute(
      new NextRequest('http://localhost/api/user/profile/floating?uid=5.5')
    )

    expect(await res.json()).toBe('用户 ID 无效')
    expect(prismaAccess).toEqual([])
  })
})
