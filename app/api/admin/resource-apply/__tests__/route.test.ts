import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunParsePutBodyMock,
  verifyHeaderCookieMock,
  findResourceMock,
  findAdminMock,
  transactionMock,
  planResourceRemovalMock,
  executeResourceRemovalMock,
  updateResourceMock,
  createLogMock,
  createMessageMock,
  recalcTypeMock,
  invalidateResourceListMock,
  invalidateContentMock,
  invalidatePendingMock,
  invalidateUnreadMock,
  queueSearchSyncMock,
  enqueueOutboxMock
} = vi.hoisted(() => ({
  kunParsePutBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  findResourceMock: vi.fn(),
  findAdminMock: vi.fn(),
  transactionMock: vi.fn(),
  planResourceRemovalMock: vi.fn(),
  executeResourceRemovalMock: vi.fn(),
  updateResourceMock: vi.fn(),
  createLogMock: vi.fn(),
  createMessageMock: vi.fn(),
  recalcTypeMock: vi.fn(),
  invalidateResourceListMock: vi.fn(),
  invalidateContentMock: vi.fn(),
  invalidatePendingMock: vi.fn(),
  invalidateUnreadMock: vi.fn(),
  queueSearchSyncMock: vi.fn(),
  enqueueOutboxMock: vi.fn()
}))

const events: string[] = []
const transactionClient = {
  patch_resource: { updateMany: updateResourceMock },
  admin_log: { create: createLogMock }
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
  kunParsePutBody: kunParsePutBodyMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_resource: { findUnique: findResourceMock },
    user: { findUnique: findAdminMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  recalcPatchType: recalcTypeMock
}))

// 删除的锁、清理顺序、出箱与缓存失效由命令自己的测试覆盖; 这里只看入口怎么用它
vi.mock('~/server/content/resource/remove', () => ({
  planResourceRemoval: planResourceRemovalMock,
  executeResourceRemoval: executeResourceRemovalMock
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: invalidateResourceListMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentMock
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: invalidatePendingMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

vi.mock('~/server/search/sync', () => ({
  queueSearchSync: queueSearchSyncMock,
  enqueueSearchOutbox: enqueueOutboxMock
}))

import { PUT as declinePut } from '~/app/api/admin/resource-apply/decline/route'
import { PUT as approvePut } from '~/app/api/admin/resource-apply/approve/route'

const request = new Request('http://localhost/api/admin/resource-apply', {
  method: 'PUT'
}) as unknown as Parameters<typeof declinePut>[0]

const pendingResource = {
  id: 3,
  name: 'r',
  section: 'patch',
  status: 2,
  user_id: 7,
  patch_id: 10,
  user: { name: 'author' },
  patch: { name: 'p', unique_id: 'unique-x' }
}

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  kunParsePutBodyMock.mockResolvedValue({ resourceId: 3, reason: '不合规' })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99, role: 4 })
  findResourceMock.mockResolvedValue(pendingResource)
  findAdminMock.mockResolvedValue({ id: 99, name: 'admin' })
  planResourceRemovalMock.mockResolvedValue({
    rows: [{ id: 3 }],
    skipped: [],
    refundPublishReward: false
  })
  executeResourceRemovalMock.mockResolvedValue({ deletedIds: [3] })
  updateResourceMock.mockResolvedValue({ count: 1 })
  createLogMock.mockResolvedValue({})
  createMessageMock.mockResolvedValue({})
  recalcTypeMock.mockResolvedValue('unique-x')
  invalidateResourceListMock.mockResolvedValue(undefined)
  invalidateContentMock.mockResolvedValue(undefined)
  invalidatePendingMock.mockResolvedValue(undefined)
  invalidateUnreadMock.mockResolvedValue(undefined)
  queueSearchSyncMock.mockReturnValue(undefined)
  enqueueOutboxMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      const result = await callback(transactionClient)
      events.push('transaction-commit')
      return result
    }
  )
})

describe('resource-apply decline', () => {
  const txContext = expect.objectContaining({ tx: transactionClient })

  it('deletes a pending resource through the removal command, guarded on the awaiting-approval status', async () => {
    const response = await declinePut(request)

    expect(await response.json()).toEqual({})
    // 回归护栏: 守卫必须是「仍待初审 (2)」, 且不收回发布奖励
    expect(planResourceRemovalMock).toHaveBeenCalledWith(txContext, [3], {
      guard: { statusIn: [2] },
      refundPublishReward: false
    })
    expect(executeResourceRemovalMock).toHaveBeenCalledWith(
      txContext,
      await planResourceRemovalMock.mock.results[0].value
    )
    // 通知与审计随删除同事务
    expect(createMessageMock).toHaveBeenCalledTimes(1)
    expect(createMessageMock.mock.calls[0][0]).toEqual({
      type: 'system',
      content: '您上传的资源「r」未通过审核，原因：不合规',
      recipient_id: 7,
      link: '/unique-x?tab=resources&resourceSection=patch'
    })
    expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
    expect(createLogMock).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['transaction-commit'])
    expect(invalidateUnreadMock).toHaveBeenCalledWith(7)
  })

  it('refuses to delete a resource that a concurrent approval already published', async () => {
    // 管理员先点「同意发布」(2→0) 后卡片仍在列表上, 再点「拒绝发布」: 行锁下读到 status 0
    planResourceRemovalMock.mockResolvedValue({
      rows: [],
      skipped: [{ id: 3, reason: 'status', status: 0 }],
      refundPublishReward: false
    })

    const response = await declinePut(request)

    expect(await response.json()).toBe('当前资源状态无需审核')
    // 事务回滚; 资源保留, 它评论区的站内信、任务、申诉、举报一概不清理
    expect(events).not.toContain('transaction-commit')
    expect(executeResourceRemovalMock).not.toHaveBeenCalled()
    expect(createMessageMock).not.toHaveBeenCalled()
    expect(createLogMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('bails out when the locked row no longer exists', async () => {
    // 并发的拒绝已删除该行
    planResourceRemovalMock.mockResolvedValue({
      rows: [],
      skipped: [{ id: 3, reason: 'gone' }],
      refundPublishReward: false
    })

    const response = await declinePut(request)

    expect(await response.json()).toBe('当前资源状态无需审核')
    expect(events).not.toContain('transaction-commit')
    expect(executeResourceRemovalMock).not.toHaveBeenCalled()
    expect(createMessageMock).not.toHaveBeenCalled()
  })

  it('propagates transaction failures', async () => {
    executeResourceRemovalMock.mockRejectedValue(new Error('connection lost'))

    await expect(declinePut(request)).rejects.toThrow('connection lost')
    expect(events).not.toContain('transaction-commit')
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })
})

describe('resource-apply approve', () => {
  it('publishes a pending resource under a status guard', async () => {
    const response = await approvePut(request)

    expect(await response.json()).toEqual({})
    expect(updateResourceMock).toHaveBeenCalledWith({
      where: { id: 3, status: 2 },
      data: { status: 0 }
    })
    expect(createMessageMock).toHaveBeenCalledTimes(1)
  })

  it('returns the string contract when the row vanished mid-flight', async () => {
    // 事务外 findUnique 与事务内写之间被并发 decline 删除: 裸 update 会抛 P2025 逃逸为 500
    updateResourceMock.mockResolvedValue({ count: 0 })

    const response = await approvePut(request)

    expect(await response.json()).toBe('当前资源状态无需审核')
    expect(createMessageMock).not.toHaveBeenCalled()
    expect(queueSearchSyncMock).not.toHaveBeenCalled()
  })

  it('keeps the pre-transaction status check', async () => {
    findResourceMock.mockResolvedValue({ ...pendingResource, status: 0 })

    const response = await approvePut(request)

    expect(await response.json()).toBe('当前资源状态无需审核')
    expect(transactionMock).not.toHaveBeenCalled()
  })
})
