import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  parsePostMock,
  verifyHeaderCookieMock,
  transactionMock,
  relationCreateManyMock,
  relationDeleteManyMock,
  createDedupMessageMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  parsePostMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  transactionMock: vi.fn(),
  relationCreateManyMock: vi.fn(),
  relationDeleteManyMock: vi.fn(),
  createDedupMessageMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const events: string[] = []

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

vi.mock('~/app/api/utils/message', () => ({
  createDedupMessage: createDedupMessageMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    $transaction: transactionMock,
    user_follow_relation: {
      deleteMany: relationDeleteManyMock
    }
  }
}))

import { POST as followRoute } from '~/app/api/user/follow/follow/route'
import { POST as unfollowRoute } from '~/app/api/user/follow/unfollow/route'

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof followRoute
>[0]

const txClient = {
  user_follow_relation: { createMany: relationCreateManyMock }
}

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  parsePostMock.mockResolvedValue({ uid: 7 })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99 })
  transactionMock.mockImplementation(async (fn) => {
    events.push('transaction-start')
    const result = await fn(txClient)
    events.push('transaction-commit')
    return result
  })
  relationCreateManyMock.mockResolvedValue({ count: 1 })
  relationDeleteManyMock.mockResolvedValue({ count: 1 })
  createDedupMessageMock.mockResolvedValue(undefined)
  invalidateUnreadMock.mockImplementation(async (uid: number) => {
    events.push(`invalidate-unread:${uid}`)
  })
})

describe('POST /api/user/follow/follow', () => {
  it('成功关注: skipDuplicates 幂等插入并经事务客户端发通知', async () => {
    const res = await followRoute(mockRequest)
    await expect(res.json()).resolves.toEqual({})

    expect(relationCreateManyMock).toHaveBeenCalledWith({
      data: [{ follower_id: 99, following_id: 7 }],
      skipDuplicates: true
    })
    expect(createDedupMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'follow', recipient_id: 7 }),
      txClient
    )
    // 被关注者未读缓存须在提交后失效 (L-01): 事务内失效会被并发读回填旧值
    expect(events).toEqual([
      'transaction-start',
      'transaction-commit',
      'invalidate-unread:7'
    ])
  })

  it('重复关注 (count 0) 幂等返回成功且不发通知', async () => {
    relationCreateManyMock.mockResolvedValue({ count: 0 })

    const res = await followRoute(mockRequest)
    await expect(res.json()).resolves.toEqual({})
    expect(createDedupMessageMock).not.toHaveBeenCalled()
    // 失效无条件跟在事务后, 多一次 DEL 无害
    expect(invalidateUnreadMock).toHaveBeenCalledWith(7)
  })

  it('关注自己直接拒绝, 不开事务也不失效缓存', async () => {
    parsePostMock.mockResolvedValue({ uid: 99 })

    const res = await followRoute(mockRequest)
    await expect(res.json()).resolves.toBe('您不能关注自己')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/user/follow/unfollow', () => {
  it('用 deleteMany 平铺条件删除关系', async () => {
    const res = await unfollowRoute(mockRequest)
    await expect(res.json()).resolves.toEqual({})

    expect(relationDeleteManyMock).toHaveBeenCalledWith({
      where: { follower_id: 99, following_id: 7 }
    })
  })

  it('关系已在别处取消时不抛错', async () => {
    relationDeleteManyMock.mockResolvedValue({ count: 0 })

    const res = await unfollowRoute(mockRequest)
    await expect(res.json()).resolves.toEqual({})
  })
})
