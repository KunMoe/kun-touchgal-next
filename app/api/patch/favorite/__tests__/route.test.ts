import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  parsePutBodyMock,
  verifyHeaderCookieMock,
  patchFindUniqueMock,
  folderFindUniqueMock,
  relationFindUniqueMock,
  relationFindFirstMock,
  relationDeleteMock,
  relationCreateMock,
  relationDeleteManyMock,
  relationCreateManyMock,
  messageDeleteManyMock,
  executeRawMock,
  transactionMock,
  createDedupMessageMock,
  invalidateFavoriteCacheMock,
  invalidateContentCacheMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  parsePutBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  patchFindUniqueMock: vi.fn(),
  folderFindUniqueMock: vi.fn(),
  relationFindUniqueMock: vi.fn(),
  relationFindFirstMock: vi.fn(),
  relationDeleteMock: vi.fn(),
  relationCreateMock: vi.fn(),
  relationDeleteManyMock: vi.fn(),
  relationCreateManyMock: vi.fn(),
  messageDeleteManyMock: vi.fn(),
  executeRawMock: vi.fn(),
  transactionMock: vi.fn(),
  createDedupMessageMock: vi.fn(),
  invalidateFavoriteCacheMock: vi.fn(),
  invalidateContentCacheMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const events: string[] = []

const transactionClient = {
  $executeRaw: executeRawMock,
  user_patch_favorite_folder_relation: {
    deleteMany: relationDeleteManyMock,
    createMany: relationCreateManyMock,
    findFirst: relationFindFirstMock,
    delete: relationDeleteMock,
    create: relationCreateMock
  },
  user_message: {
    deleteMany: messageDeleteManyMock
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

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchFavoriteCache: invalidateFavoriteCacheMock,
  invalidatePatchContentCache: invalidateContentCacheMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findUnique: patchFindUniqueMock },
    user_patch_favorite_folder: { findUnique: folderFindUniqueMock },
    user_patch_favorite_folder_relation: {
      findUnique: relationFindUniqueMock
    },
    $transaction: transactionMock
  }
}))

import { PUT } from '~/app/api/patch/favorite/route'

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof PUT
>[0]

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  parsePutBodyMock.mockResolvedValue({ patchId: 7, folderId: 3 })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99 })
  patchFindUniqueMock.mockResolvedValue({
    user_id: 1,
    name: 'Test Galgame',
    unique_id: 'kun123'
  })
  folderFindUniqueMock.mockResolvedValue({ user_id: 99 })
  relationFindUniqueMock.mockResolvedValue(null)
  relationFindFirstMock.mockResolvedValue(null)
  executeRawMock.mockResolvedValue(1)
  relationDeleteManyMock.mockResolvedValue({ count: 0 })
  relationCreateManyMock.mockResolvedValue({ count: 1 })
  createDedupMessageMock.mockResolvedValue(undefined)
  invalidateFavoriteCacheMock.mockResolvedValue(undefined)
  invalidateContentCacheMock.mockResolvedValue(undefined)
  invalidateUnreadMock.mockImplementation(async (uid: number) => {
    events.push(`invalidate-unread:${uid}`)
  })
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      events.push('transaction-start')
      const result = await callback(transactionClient)
      events.push('transaction-commit')
      return result
    }
  )
})

describe('PUT /api/patch/favorite', () => {
  it('adds atomically via deleteMany + createMany(skipDuplicates) inside the transaction', async () => {
    const res = await PUT(mockRequest)
    await expect(res.json()).resolves.toEqual({ added: true, isFavorite: true })

    expect(relationFindUniqueMock).not.toHaveBeenCalled()
    expect(relationFindFirstMock).not.toHaveBeenCalled()
    expect(relationDeleteMock).not.toHaveBeenCalled()
    expect(relationCreateMock).not.toHaveBeenCalled()

    expect(relationDeleteManyMock).toHaveBeenCalledWith({
      where: { folder_id: 3, patch_id: 7 }
    })
    expect(relationCreateManyMock).toHaveBeenCalledWith({
      data: { folder_id: 3, patch_id: 7 },
      skipDuplicates: true
    })
    // 补丁作者未读缓存须在提交后失效 (L-01): 事务内失效会被并发读回填旧值
    expect(events).toEqual([
      'transaction-start',
      'transaction-commit',
      'invalidate-unread:1'
    ])
  })

  it('takes a (namespace, folderId) advisory lock before any relation access', async () => {
    await PUT(mockRequest)

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    const [strings, ...values] = executeRawMock.mock.calls[0]
    expect(strings.join('')).toContain('pg_advisory_xact_lock')
    expect(strings.join('')).toContain('::int')
    // [FAVORITE_LOCK_NAMESPACE, folderId]: 域常量隔离, 不与 patch type/rating 锁碰撞
    expect(values).toEqual([481003, 3])
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      relationDeleteManyMock.mock.invocationCallOrder[0]
    )
  })

  it('removes via deleteMany count without issuing a create', async () => {
    relationDeleteManyMock.mockResolvedValue({ count: 1 })

    const res = await PUT(mockRequest)
    await expect(res.json()).resolves.toEqual({
      added: false,
      isFavorite: false
    })
    expect(relationCreateManyMock).not.toHaveBeenCalled()
    // 聚合态按 (patch, 用户所有收藏夹) 回查, 而非只看被 toggle 的这一夹
    expect(relationFindFirstMock).toHaveBeenCalledWith({
      where: { patch_id: 7, folder: { user_id: 99 } },
      select: { id: true }
    })
  })

  it('keeps isFavorite=true when the patch remains in another folder after removal', async () => {
    relationDeleteManyMock.mockResolvedValue({ count: 1 })
    relationFindFirstMock.mockResolvedValue({ id: 42 })

    const res = await PUT(mockRequest)
    await expect(res.json()).resolves.toEqual({
      added: false,
      isFavorite: true
    })
  })

  it('cleans up the notification instead of sending one when removing', async () => {
    relationDeleteManyMock.mockResolvedValue({ count: 1 })

    await PUT(mockRequest)

    expect(createDedupMessageMock).not.toHaveBeenCalled()
    expect(messageDeleteManyMock).toHaveBeenCalledWith({
      where: {
        type: 'favorite',
        sender_id: 99,
        recipient_id: 1,
        link: '/kun123?folderId=3'
      }
    })
    // 删通知同样改变作者未读态, 取消收藏也要失效
    expect(invalidateUnreadMock).toHaveBeenCalledWith(1)
  })

  it('does not notify or invalidate the author when favoriting your own patch', async () => {
    patchFindUniqueMock.mockResolvedValue({
      user_id: 99,
      name: 'Test Galgame',
      unique_id: 'kun123'
    })

    const res = await PUT(mockRequest)
    await expect(res.json()).resolves.toEqual({ added: true, isFavorite: true })
    expect(createDedupMessageMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('threads the transaction client into createDedupMessage', async () => {
    await PUT(mockRequest)

    expect(createDedupMessageMock).toHaveBeenCalledWith(
      {
        type: 'favorite',
        content: 'Test Galgame',
        sender_id: 99,
        recipient_id: 1,
        link: '/kun123?folderId=3'
      },
      transactionClient
    )
  })

  it('returns a friendly message when the folder vanishes concurrently (P2003)', async () => {
    transactionMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('FK violation', {
        code: 'P2003',
        clientVersion: 'test'
      })
    )

    const res = await PUT(mockRequest)
    await expect(res.json()).resolves.toBe('收藏失败, 请重试')
    expect(invalidateFavoriteCacheMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })
})
