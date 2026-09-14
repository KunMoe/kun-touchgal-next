import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  parsePutBodyMock,
  verifyHeaderCookieMock,
  commentFindUniqueMock,
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
  invalidateUnreadMock,
  invalidateCommentCacheMock
} = vi.hoisted(() => ({
  parsePutBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  commentFindUniqueMock: vi.fn(),
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
  invalidateUnreadMock: vi.fn(),
  invalidateCommentCacheMock: vi.fn()
}))

const transactionClient = {
  $executeRaw: executeRawMock,
  user_patch_comment_like_relation: {
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

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: invalidateCommentCacheMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findUnique: commentFindUniqueMock },
    user_patch_comment_like_relation: { findUnique: likeFindUniqueMock },
    $transaction: transactionMock
  }
}))

import { PUT } from '~/app/api/patch/comment/like/route'

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof PUT
>[0]

const COMMENT_LINK = '/kun123?tab=comments&commentId=8'

beforeEach(() => {
  vi.clearAllMocks()
  parsePutBodyMock.mockResolvedValue({ commentId: 8 })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99 })
  commentFindUniqueMock.mockResolvedValue({
    id: 8,
    user_id: 1,
    status: 0,
    content: '说得好',
    resource_id: null,
    patch_id: 7,
    patch: { unique_id: 'kun123' }
  })
  executeRawMock.mockResolvedValue(1)
  likeDeleteManyMock.mockResolvedValue({ count: 0 })
  likeCreateManyMock.mockResolvedValue({ count: 1 })
  messageDeleteManyMock.mockResolvedValue({ count: 1 })
  userUpdateMock.mockResolvedValue({})
  createDedupMessageMock.mockResolvedValue(undefined)
  invalidateUserSessionMock.mockResolvedValue(undefined)
  invalidateUnreadMock.mockResolvedValue(undefined)
  invalidateCommentCacheMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('PUT /api/patch/comment/like', () => {
  it('takes a (namespace, uid) advisory lock before touching the like row', async () => {
    await PUT(mockRequest)

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    const [strings, ...values] = executeRawMock.mock.calls[0]
    expect(strings.join('')).toContain('pg_advisory_xact_lock')
    expect(strings.join('')).toContain('::int')
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
      where: { user_id: 99, comment_id: 8 }
    })
    expect(likeCreateManyMock).toHaveBeenCalledWith({
      data: { user_id: 99, comment_id: 8 },
      skipDuplicates: true
    })
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { moemoepoint: { increment: 1 } }
    })
    expect(createDedupMessageMock).toHaveBeenCalledWith(
      {
        type: 'like',
        content: '赞了您的评论：说得好',
        sender_id: 99,
        recipient_id: 1,
        link: COMMENT_LINK
      },
      transactionClient
    )
    // 通知随事务落库后才失效作者未读缓存 (L-01): 事务内失效会被并发读回填旧值
    expect(invalidateUnreadMock).toHaveBeenCalledWith(1)
    expect(userUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateUnreadMock.mock.invocationCallOrder[0]
    )
    // 分页共享缓存内嵌 likeCount, 同样提交后失效, 否则与读路径叠加的 isLike 矛盾
    expect(invalidateCommentCacheMock).toHaveBeenCalledWith(7)
    expect(userUpdateMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateCommentCacheMock.mock.invocationCallOrder[0]
    )
  })

  it('unlikes via the deleteMany count and still clears the legacy notification link', async () => {
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
        OR: [
          { link: COMMENT_LINK },
          { link: '/kun123', content: '赞了您的评论：说得好' }
        ]
      }
    })
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { moemoepoint: { increment: -1 } }
    })
    // 取消点赞删除通知同样改变作者未读状态, 亦须失效
    expect(invalidateUnreadMock).toHaveBeenCalledWith(1)
    // 取消点赞同样改变 likeCount
    expect(invalidateCommentCacheMock).toHaveBeenCalledWith(7)
  })

  it('returns a business message when the comment vanishes concurrently (P2003)', async () => {
    transactionMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('FK violation', {
        code: 'P2003',
        clientVersion: 'test'
      })
    )

    const res = await PUT(mockRequest)
    await expect(res.json()).resolves.toBe('未找到评论')
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
    // 点赞未落库, 不应白白跳变版本号压低命中率
    expect(invalidateCommentCacheMock).not.toHaveBeenCalled()
  })

  it('rethrows non-P2003 transaction failures', async () => {
    transactionMock.mockRejectedValue(new Error('connection reset'))

    await expect(PUT(mockRequest)).rejects.toThrow('connection reset')
  })
})
