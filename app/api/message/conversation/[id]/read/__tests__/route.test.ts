import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  verifyHeaderCookieMock,
  conversationFindUniqueMock,
  conversationUpdateMock,
  privateMessageUpdateManyMock,
  lockQueryMock,
  getUnreadMessageStatusMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  conversationUpdateMock: vi.fn(),
  privateMessageUpdateManyMock: vi.fn(),
  lockQueryMock: vi.fn(),
  getUnreadMessageStatusMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// 写入 mock 只挂在 tx 客户端上: 实现若退回「顶层 prisma 直调」的非事务形状,
// 用例会因 undefined 直接崩, 这是对事务边界的结构性断言
vi.mock('~/prisma/index', () => ({
  prisma: {
    user_conversation: { findUnique: conversationFindUniqueMock },
    $transaction: async (callback: (tx: unknown) => unknown) =>
      callback({
        $queryRaw: lockQueryMock,
        user_conversation: { update: conversationUpdateMock },
        user_private_message: { updateMany: privateMessageUpdateManyMock }
      })
  }
}))

vi.mock('~/app/api/message/unread/service', () => ({
  getUnreadMessageStatus: getUnreadMessageStatusMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

import { PUT } from '~/app/api/message/conversation/[id]/read/route'

const UID = 7
const params = Promise.resolve({ id: '1' })

describe('conversation/[id]/read PUT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyHeaderCookieMock.mockResolvedValue({ uid: UID })
    conversationFindUniqueMock.mockResolvedValue({
      id: 1,
      user_a_id: UID,
      user_b_id: 99
    })
    lockQueryMock.mockResolvedValue([{ id: 1 }])
    conversationUpdateMock.mockResolvedValue({})
    privateMessageUpdateManyMock.mockResolvedValue({ count: 0 })
    invalidateUnreadMock.mockResolvedValue(undefined)
    getUnreadMessageStatusMock.mockResolvedValue({
      hasUnreadNotification: false,
      hasUnreadConversation: false
    })
  })

  it('事务首条对会话行 FOR UPDATE, 先于标已读与清零', async () => {
    await PUT({} as never, { params })

    // 锁不前置则发送方的插入+递增仍能落在 updateMany 与清零之间, 角标照丢
    const [sql, ...values] = lockQueryMock.mock.calls[0]
    expect(sql.join('?')).toContain('FOR UPDATE')
    expect(sql.join('?')).toContain('user_conversation')
    expect(values).toEqual([1])
    expect(lockQueryMock.mock.invocationCallOrder[0]).toBeLessThan(
      privateMessageUpdateManyMock.mock.invocationCallOrder[0]
    )
    expect(
      privateMessageUpdateManyMock.mock.invocationCallOrder[0]
    ).toBeLessThan(conversationUpdateMock.mock.invocationCallOrder[0])
  })

  it('锁行落空时返回错误字符串, 不发生任何写入', async () => {
    lockQueryMock.mockResolvedValue([])

    const res = await PUT({} as never, { params })

    expect(await res.json()).toBe('会话不存在')
    expect(privateMessageUpdateManyMock).not.toHaveBeenCalled()
    expect(conversationUpdateMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('invalidates the unread cache before recomputing status', async () => {
    const res = await PUT({} as never, { params })

    expect(invalidateUnreadMock).toHaveBeenCalledWith(UID)
    expect(getUnreadMessageStatusMock).toHaveBeenCalledWith(UID)
    expect(invalidateUnreadMock.mock.invocationCallOrder[0]).toBeLessThan(
      getUnreadMessageStatusMock.mock.invocationCallOrder[0]
    )
    expect(await res.json()).toEqual({
      hasUnreadNotification: false,
      hasUnreadConversation: false
    })
  })

  it('does not invalidate when the conversation is inaccessible', async () => {
    conversationFindUniqueMock.mockResolvedValue({
      id: 1,
      user_a_id: 100,
      user_b_id: 200
    })

    await PUT({} as never, { params })

    expect(invalidateUnreadMock).not.toHaveBeenCalled()
    expect(getUnreadMessageStatusMock).not.toHaveBeenCalled()
  })

  // 越界值裸穿到 Int 主键会让 prisma 抛 P2020, 必须在 handler 就截断
  it('会话 ID 越过 int4 时拒绝, 不触达 prisma', async () => {
    const res = await PUT({} as never, {
      params: Promise.resolve({ id: '99999999999' })
    })

    expect(await res.json()).toBe('无效的会话 ID')
    expect(conversationFindUniqueMock).not.toHaveBeenCalled()
    expect(lockQueryMock).not.toHaveBeenCalled()
  })
})
