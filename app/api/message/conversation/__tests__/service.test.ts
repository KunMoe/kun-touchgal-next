import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '~/prisma/generated/prisma/client'

const {
  txState,
  userFindUniqueMock,
  userUpdateMock,
  userUpdateManyMock,
  conversationFindUniqueMock,
  conversationFindManyMock,
  conversationCountMock,
  conversationCreateMock,
  invalidateUserSessionMock,
  getUnreadMock
} = vi.hoisted(() => ({
  txState: { committed: false },
  userFindUniqueMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  conversationFindManyMock: vi.fn(),
  conversationCountMock: vi.fn(),
  conversationCreateMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  getUnreadMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      findUnique: userFindUniqueMock,
      update: userUpdateMock,
      updateMany: userUpdateManyMock
    },
    user_conversation: {
      findUnique: conversationFindUniqueMock,
      findMany: conversationFindManyMock,
      count: conversationCountMock,
      create: conversationCreateMock
    },
    // 回调正常返回即提交, 只有抛出才回滚. committed 必须记录, 否则分不清
    // 守卫落空时是回滚了还是带着已做的写入提交了
    $transaction: async (callback: (tx: unknown) => unknown) => {
      const result = await callback({
        user: { update: userUpdateMock, updateMany: userUpdateManyMock },
        user_conversation: { create: conversationCreateMock }
      })
      txState.committed = true
      return result
    }
  }
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

vi.mock('~/app/api/message/unread/service', () => ({
  getUnreadMessageStatus: getUnreadMock
}))

import {
  checkConversation,
  getConversations,
  getOrCreateConversation
} from '~/app/api/message/conversation/service'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'

const UID = 1
const TARGET_UID = 2
const NORMAL_ROLE = 1
const PRIVILEGED_ROLE = 3

const duplicateError = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test'
  })

describe('getOrCreateConversation', () => {
  beforeEach(() => {
    // 必须是 reset 而非 clear: clearAllMocks 不清 mockResolvedValueOnce 队列,
    // 下面撞唯一索引那条用例一旦没消费完 once, 剩下的会泄漏给后续用例
    vi.resetAllMocks()
    txState.committed = false
    userFindUniqueMock.mockImplementation(
      ({ where }: { where: { id: number } }) =>
        where.id === UID
          ? Promise.resolve({ moemoepoint: 20 })
          : Promise.resolve({ id: TARGET_UID, allow_private_message: true })
    )
    conversationFindUniqueMock.mockResolvedValue(null)
    userUpdateManyMock.mockResolvedValue({ count: 1 })
    conversationCreateMock.mockResolvedValue({ id: 7 })
    invalidateUserSessionMock.mockResolvedValue(undefined)
  })

  it('扣费走带余额守卫的 updateMany, 而不是无谓词的 update', async () => {
    const result = await getOrCreateConversation(
      { targetUserId: TARGET_UID },
      kunTestActor({ uid: UID, role: NORMAL_ROLE })
    )

    expect(result).toEqual({ conversationId: 7, isNew: true })
    // 守卫必须落在 WHERE 里: 退回「事务外读余额 + 应用层 if + 无谓词 decrement」
    // 就是读后写竞态, 对 N 个不同目标并发能把余额扣成负数 (唯一索引只约束同一对用户)
    expect(userUpdateMock).not.toHaveBeenCalled()
    expect(userUpdateManyMock).toHaveBeenCalledWith({
      where: { id: UID, moemoepoint: { gte: 20 } },
      data: { moemoepoint: { decrement: 10 } }
    })
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(UID)
  })

  it('守卫落空时返回错误字符串, 事务回滚', async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 })

    const result = await getOrCreateConversation(
      { targetUserId: TARGET_UID },
      kunTestActor({ uid: UID, role: NORMAL_ROLE })
    )

    expect(result).toBe('萌萌点不足，发起私聊需要至少 20 萌萌点')
    expect(conversationCreateMock).not.toHaveBeenCalled()
    expect(txState.committed).toBe(false)
  })

  it('守卫落空但会话已被并发请求建好时, 回读已有会话而非报余额不足', async () => {
    // 余额 20~29 的并发落败者: EPQ 重求值使 CAS 落空, 走不到 create 撞 P2002
    userUpdateManyMock.mockResolvedValue({ count: 0 })
    conversationFindUniqueMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 9 })

    const result = await getOrCreateConversation(
      { targetUserId: TARGET_UID },
      kunTestActor({ uid: UID, role: NORMAL_ROLE })
    )

    // isNew 必须是 false: 本次请求没扣费, 客户端据此不弹「已消耗」提示
    expect(result).toEqual({ conversationId: 9, isNew: false })
    expect(conversationCreateMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
    expect(txState.committed).toBe(false)
  })

  it('撞唯一索引时回读已有会话, 并标记本次未扣费', async () => {
    conversationFindUniqueMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 9 })
    conversationCreateMock.mockRejectedValue(duplicateError())

    const result = await getOrCreateConversation(
      { targetUserId: TARGET_UID },
      kunTestActor({ uid: UID, role: NORMAL_ROLE })
    )

    // isNew 必须是 false: 扣费与 create 同事务已整条回滚, 客户端据此不弹「已消耗」提示
    expect(result).toEqual({ conversationId: 9, isNew: false })
    // 事务未提交才是「落败者不白扣分」的依据 —— 扣费一旦挪出这个事务就会破
    expect(txState.committed).toBe(false)
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })

  it('特权用户撞唯一索引时同样回读, 且全程不扣费', async () => {
    conversationFindUniqueMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 9 })
    conversationCreateMock.mockRejectedValue(duplicateError())

    const result = await getOrCreateConversation(
      { targetUserId: TARGET_UID },
      kunTestActor({ uid: UID, role: PRIVILEGED_ROLE })
    )

    expect(result).toEqual({ conversationId: 9, isNew: false })
    expect(userUpdateManyMock).not.toHaveBeenCalled()
  })

  it('非 P2002 的错误原样抛出', async () => {
    conversationCreateMock.mockRejectedValue(new Error('boom'))

    await expect(
      getOrCreateConversation(
        { targetUserId: TARGET_UID },
        kunTestActor({ uid: UID, role: NORMAL_ROLE })
      )
    ).rejects.toThrow('boom')
  })

  // message.skipPointsGate 的边界: 创作者 (role 2) 与普通用户一样受萌萌点门槛约束并付费,
  // 管理员 (role 3) 起免门槛免费
  it.each([
    { role: 1, pays: true },
    { role: 2, pays: true },
    { role: 3, pays: false },
    { role: 4, pays: false }
  ] as const)('萌萌点 20 时 role $role 是否扣费', async ({ role, pays }) => {
    const result = await getOrCreateConversation(
      { targetUserId: TARGET_UID },
      kunTestActor({ uid: UID, role })
    )

    expect(result).toEqual({ conversationId: 7, isNew: true })
    if (pays) {
      expect(userUpdateManyMock).toHaveBeenCalledWith({
        where: { id: UID, moemoepoint: { gte: 20 } },
        data: { moemoepoint: { decrement: 10 } }
      })
    } else {
      expect(userUpdateManyMock).not.toHaveBeenCalled()
    }
  })

  it.each([
    { role: 1, expected: '萌萌点不足，发起私聊需要至少 20 萌萌点' },
    { role: 2, expected: '萌萌点不足，发起私聊需要至少 20 萌萌点' },
    { role: 3, expected: { conversationId: 7, isNew: true } },
    { role: 4, expected: { conversationId: 7, isNew: true } }
  ] as const)('萌萌点 19 时 role $role 的结果', async ({ role, expected }) => {
    userFindUniqueMock.mockImplementation(
      ({ where }: { where: { id: number } }) =>
        where.id === UID
          ? Promise.resolve({ moemoepoint: 19 })
          : Promise.resolve({ id: TARGET_UID, allow_private_message: true })
    )

    const result = await getOrCreateConversation(
      { targetUserId: TARGET_UID },
      kunTestActor({ uid: UID, role })
    )

    expect(result).toEqual(expected)
  })
})

describe('checkConversation 萌萌点门槛的角色边界 (message.skipPointsGate)', () => {
  const INSUFFICIENT = { error: '萌萌点不足，发起私聊需要至少 20 萌萌点' }
  const preview = (needsPayment: boolean, currentPoints: number) => ({
    exists: false,
    needsPayment,
    cost: 10,
    currentPoints,
    targetUserName: 'target'
  })

  it.each([
    { role: 1, points: 19, expected: INSUFFICIENT },
    { role: 2, points: 19, expected: INSUFFICIENT },
    { role: 2, points: 20, expected: preview(true, 20) },
    { role: 3, points: 19, expected: preview(false, 19) },
    { role: 4, points: 19, expected: preview(false, 19) }
  ] as const)(
    'role $role 萌萌点 $points 的预检结果',
    async ({ role, points, expected }) => {
      vi.resetAllMocks()
      userFindUniqueMock.mockImplementation(
        ({ where }: { where: { id: number } }) =>
          where.id === UID
            ? Promise.resolve({ moemoepoint: points })
            : Promise.resolve({
                id: TARGET_UID,
                name: 'target',
                allow_private_message: true
              })
      )
      conversationFindUniqueMock.mockResolvedValue(null)

      const result = await checkConversation(
        { targetUserId: TARGET_UID },
        kunTestActor({ uid: UID, role })
      )

      expect(result).toEqual(expected)
    }
  )
})

describe('getConversations', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // P28-03: 列表页曾用本页的 unreadCount 推导全局私聊红点, 未读会话不在本页时把红点清掉
  it('顺带返回该用户的全局未读快照, 与本页有没有未读会话无关', async () => {
    conversationFindManyMock.mockResolvedValue([])
    conversationCountMock.mockResolvedValue(31)
    const unread = {
      hasUnreadNotification: true,
      hasUnreadConversation: true,
      asOf: 42
    }
    getUnreadMock.mockResolvedValue(unread)

    const result = await getConversations({ page: 2, limit: 30 }, UID)

    expect(getUnreadMock).toHaveBeenCalledWith(UID)
    expect(result.unread).toEqual(unread)
  })

  it('lastMessage 预览在查询谓词里过滤已删除消息', async () => {
    conversationFindManyMock.mockResolvedValue([
      {
        id: 1,
        user_a_id: UID,
        user_b_id: TARGET_UID,
        user_a: { id: UID, name: 'a', avatar: '' },
        user_b: { id: TARGET_UID, name: 'b', avatar: '' },
        messages: [{ content: 'visible' }],
        last_message_time: new Date(),
        user_a_unread_count: 0,
        user_b_unread_count: 3
      }
    ])
    conversationCountMock.mockResolvedValue(1)
    getUnreadMock.mockResolvedValue({
      hasUnreadNotification: false,
      hasUnreadConversation: true,
      asOf: 1
    })

    const result = await getConversations({ page: 1, limit: 10 }, UID)

    expect(result).toMatchObject({
      total: 1,
      conversations: [{ id: 1, lastMessage: 'visible' }]
    })
    // 遮蔽必须落在 include 的 where 里: 被删消息恰是最后一条时, 其原文
    // 不能进对方的会话列表预览, 预览应回退到最近一条未删消息
    expect(conversationFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          messages: expect.objectContaining({
            where: { is_deleted: false }
          })
        })
      })
    )
  })
})
