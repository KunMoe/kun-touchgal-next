import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  parsePutBodyMock,
  verifyHeaderCookieMock,
  ratingFindUniqueMock,
  likeFindUniqueMock,
  likeDeleteMock,
  likeCreateMock,
  likeDeleteManyMock,
  likeCreateManyMock,
  messageDeleteManyMock,
  userUpdateMock,
  executeRawMock,
  transactionMock,
  createDedupMessageMock,
  invalidateUserSessionMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  parsePutBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  ratingFindUniqueMock: vi.fn(),
  likeFindUniqueMock: vi.fn(),
  likeDeleteMock: vi.fn(),
  likeCreateMock: vi.fn(),
  likeDeleteManyMock: vi.fn(),
  likeCreateManyMock: vi.fn(),
  messageDeleteManyMock: vi.fn(),
  userUpdateMock: vi.fn(),
  executeRawMock: vi.fn(),
  transactionMock: vi.fn(),
  createDedupMessageMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const transactionClient = {
  $executeRaw: executeRawMock,
  patch_rating_like: {
    deleteMany: likeDeleteManyMock,
    createMany: likeCreateManyMock,
    delete: likeDeleteMock,
    create: likeCreateMock
  },
  user_message: {
    deleteMany: messageDeleteManyMock
  },
  user: {
    update: userUpdateMock
  }
}

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePutBody: parsePutBodyMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/api/utils/message', () => ({
  createDedupMessage: createDedupMessageMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_rating: { findUnique: ratingFindUniqueMock },
    patch_rating_like: { findUnique: likeFindUniqueMock },
    $transaction: transactionMock
  }
}))

import { PUT } from '~/app/api/patch/rating/like/route'

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof PUT
>[0]

const RATING_LINK = '/kun123?tab=rating&ratingId=5'

beforeEach(() => {
  vi.clearAllMocks()
  parsePutBodyMock.mockResolvedValue({ ratingId: 5 })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99 })
  ratingFindUniqueMock.mockResolvedValue({
    id: 5,
    user_id: 1,
    status: 0,
    short_summary: '很好玩',
    patch: { unique_id: 'kun123', name: 'Test Galgame' }
  })
  executeRawMock.mockResolvedValue(1)
  likeDeleteManyMock.mockResolvedValue({ count: 0 })
  likeCreateManyMock.mockResolvedValue({ count: 1 })
  messageDeleteManyMock.mockResolvedValue({ count: 1 })
  userUpdateMock.mockResolvedValue({})
  createDedupMessageMock.mockResolvedValue(undefined)
  invalidateUserSessionMock.mockResolvedValue(undefined)
  invalidateUnreadMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('PUT /api/patch/rating/like', () => {
  it('takes a (namespace, uid) advisory lock before touching the like row', async () => {
    await PUT(mockRequest)

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    const [strings, ...values] = executeRawMock.mock.calls[0]
    expect(strings.join('')).toContain('pg_advisory_xact_lock')
    expect(strings.join('')).toContain('::int')
    // [LIKE_LOCK_NAMESPACE, uid]: 按点赞者串行, 与 patch type/rating/收藏 锁不碰撞
    expect(values).toEqual([481004, 99])
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      likeDeleteManyMock.mock.invocationCallOrder[0]
    )
  })

  it('likes atomically via deleteMany + createMany(skipDuplicates) inside the transaction', async () => {
    const res = await PUT(mockRequest)
    await expect(res.json()).resolves.toBe(true)

    // 事务外的存在性探测 (check-then-act) 已移除, 无守卫的 create/delete 亦不再使用
    expect(likeFindUniqueMock).not.toHaveBeenCalled()
    expect(likeCreateMock).not.toHaveBeenCalled()
    expect(likeDeleteMock).not.toHaveBeenCalled()

    expect(likeDeleteManyMock).toHaveBeenCalledWith({
      where: { patch_rating_id: 5, user_id: 99 }
    })
    expect(likeCreateManyMock).toHaveBeenCalledWith({
      data: { patch_rating_id: 5, user_id: 99 },
      skipDuplicates: true
    })
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { moemoepoint: { increment: 1 } }
    })
    expect(createDedupMessageMock).toHaveBeenCalledWith(
      {
        type: 'like',
        content: '赞了您的评价：很好玩',
        sender_id: 99,
        recipient_id: 1,
        link: RATING_LINK
      },
      transactionClient
    )
    // 通知随事务落库后才失效作者未读缓存 (L-01): 事务内失效会被并发读回填旧值
    expect(invalidateUnreadMock).toHaveBeenCalledWith(1)
    expect(userUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateUnreadMock.mock.invocationCallOrder[0]
    )
  })

  it('unlikes via the deleteMany count without issuing a create', async () => {
    likeDeleteManyMock.mockResolvedValue({ count: 1 })

    const res = await PUT(mockRequest)
    await expect(res.json()).resolves.toBe(false)

    expect(likeCreateManyMock).not.toHaveBeenCalled()
    expect(createDedupMessageMock).not.toHaveBeenCalled()
    expect(messageDeleteManyMock).toHaveBeenCalledWith({
      where: {
        type: 'like',
        sender_id: 99,
        recipient_id: 1,
        link: RATING_LINK
      }
    })
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { moemoepoint: { increment: -1 } }
    })
    // 取消点赞删除通知同样改变作者未读状态, 亦须失效
    expect(invalidateUnreadMock).toHaveBeenCalledWith(1)
  })

  it('returns a business message when the rating vanishes concurrently (P2003)', async () => {
    transactionMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('FK violation', {
        code: 'P2003',
        clientVersion: 'test'
      })
    )

    const res = await PUT(mockRequest)
    await expect(res.json()).resolves.toBe('评价不存在')
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('rethrows non-P2003 transaction failures', async () => {
    transactionMock.mockRejectedValue(new Error('connection reset'))

    await expect(PUT(mockRequest)).rejects.toThrow('connection reset')
  })
})
