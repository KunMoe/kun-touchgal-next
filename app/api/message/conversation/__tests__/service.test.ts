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
  invalidateUserSessionMock
} = vi.hoisted(() => ({
  txState: { committed: false },
  userFindUniqueMock: vi.fn(),
  userUpdateMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  conversationFindUniqueMock: vi.fn(),
  conversationFindManyMock: vi.fn(),
  conversationCountMock: vi.fn(),
  conversationCreateMock: vi.fn(),
  invalidateUserSessionMock: vi.fn()
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
    // 回调正常返回即提交, 只有抛出才回滚. committed 必须记录, 否则测不出
    // 「回调 return 错误字符串也会提交」这类误提交
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

import {
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

  it('守卫落空时返回错误字符串, 提交的事务里没有任何写入', async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 })

    const result = await getOrCreateConversation(
      { targetUserId: TARGET_UID },
      kunTestActor({ uid: UID, role: NORMAL_ROLE })
    )

    expect(result).toBe('萌萌点不足，发起私聊需要至少 20 萌萌点')
    expect(conversationCreateMock).not.toHaveBeenCalled()
    // 事务照常提交 —— 所以回调只能返回 null, 换成错误字符串再往下写就会留下已提交的孤儿行
    expect(txState.committed).toBe(true)
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
    // 落空事务照常提交, 里面没有任何写入
    expect(txState.committed).toBe(true)
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
})

describe('getConversations', () => {
  beforeEach(() => {
    vi.resetAllMocks()
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
