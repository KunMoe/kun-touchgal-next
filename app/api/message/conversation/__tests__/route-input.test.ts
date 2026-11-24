import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// 走真实的 kunRoute 与解析器。小数 targetUserId 放行的话, 「不能和自己创建会话」的守卫拿
// 5.5 与 5 比较不相等, Prisma 又把 5.5 截成 5, 建出 user_a_id = user_b_id 的会话 (P08-02)

const { verifyHeaderCookieMock, kunAbuseGateMock, prismaAccess } = vi.hoisted(
  () => ({
    verifyHeaderCookieMock: vi.fn(),
    kunAbuseGateMock: vi.fn(),
    prismaAccess: [] as string[]
  })
)

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))
vi.mock('~/server/abuse/budget', () => ({ kunAbuseGate: kunAbuseGateMock }))
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

import { POST } from '~/app/api/message/conversation/route'

const post = (body: unknown) =>
  new NextRequest('http://localhost/api/message/conversation', {
    method: 'POST',
    body: JSON.stringify(body)
  })

beforeEach(() => {
  vi.resetAllMocks()
  prismaAccess.length = 0
  verifyHeaderCookieMock.mockResolvedValue({ uid: 5, role: 1, name: 'kun' })
  kunAbuseGateMock.mockResolvedValue(null)
})

describe('POST /api/message/conversation 的 targetUserId 必须是整数', () => {
  it('会话 uid + 0.5 被拒, 不碰库', async () => {
    const res = await POST(post({ targetUserId: 5.5 }))

    expect(await res.json()).toBe('用户 ID 无效')
    expect(prismaAccess).toEqual([])
  })

  it('整数的自身 uid 由守卫拦下', async () => {
    const res = await POST(post({ targetUserId: 5 }))

    expect(await res.json()).toBe('不能和自己创建会话')
    expect(prismaAccess).toEqual([])
  })
})
