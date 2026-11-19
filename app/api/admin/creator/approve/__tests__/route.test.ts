import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunParsePutBodyMock,
  verifyHeaderCookieMock,
  findMessageMock,
  findUserMock,
  transactionMock,
  updateMessageMock,
  updateUserMock,
  createAdminLogMock,
  createMessageMock,
  invalidateUserSessionMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  kunParsePutBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  findMessageMock: vi.fn(),
  findUserMock: vi.fn(),
  transactionMock: vi.fn(),
  updateMessageMock: vi.fn(),
  updateUserMock: vi.fn(),
  createAdminLogMock: vi.fn(),
  createMessageMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const transactionClient = {
  user_message: { updateMany: updateMessageMock },
  user: { updateMany: updateUserMock },
  admin_log: { create: createAdminLogMock }
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
    user_message: { findUnique: findMessageMock },
    user: { findUnique: findUserMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

vi.mock('~/server/auth/sessionCache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

import { PUT } from '~/app/api/admin/creator/approve/route'

const request = new Request('http://localhost/api/admin/creator/approve', {
  method: 'PUT'
}) as unknown as Parameters<typeof PUT>[0]

beforeEach(() => {
  vi.resetAllMocks()
  kunParsePutBodyMock.mockResolvedValue({ messageId: 1, uid: 7 })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99, role: 4 })
  findMessageMock.mockResolvedValue({
    id: 1,
    type: 'apply',
    status: 0,
    sender_id: 7
  })
  findUserMock.mockImplementation(
    async ({ where }: { where: { id: number } }) =>
      where.id === 7
        ? { id: 7, name: 'creator', role: 1, _count: { patch_resource: 3 } }
        : { id: 99, name: 'admin', role: 4 }
  )
  updateMessageMock.mockResolvedValue({ count: 1 })
  updateUserMock.mockResolvedValue({ count: 1 })
  createAdminLogMock.mockResolvedValue({})
  createMessageMock.mockResolvedValue({})
  invalidateUserSessionMock.mockResolvedValue(undefined)
  invalidateUnreadMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      // 事务回调中途 return 字符串仍会提交, mock 须保持同一语义
      callback(transactionClient)
  )
})

describe('PUT /api/admin/creator/approve', () => {
  it('approves a pending application and promotes the applicant', async () => {
    const response = await PUT(request)

    await expect(response.json()).resolves.toEqual({})
    // 幂等闸门: 仅未处理 (0/1) 的申请可命中
    expect(updateMessageMock).toHaveBeenCalledWith({
      where: { id: 1, status: { in: [0, 1] } },
      data: { status: { set: 2 } }
    })
    // 防降级: 只提升 role < 2 的用户, 在任管理员不受 role 覆盖影响
    expect(updateUserMock).toHaveBeenCalledWith({
      where: { id: 7, role: { lt: 2 } },
      data: { role: { set: 2 } }
    })
    expect(createMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'apply', recipient_id: 7 }),
      transactionClient
    )
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(7)
    expect(invalidateUnreadMock).toHaveBeenCalledWith(7)
  })

  it('rejects re-approving an already handled application', async () => {
    updateMessageMock.mockResolvedValue({ count: 0 })

    const response = await PUT(request)

    await expect(response.json()).resolves.toBe('该申请已被处理, 请刷新后重试')
    expect(updateUserMock).not.toHaveBeenCalled()
    expect(createMessageMock).not.toHaveBeenCalled()
    expect(createAdminLogMock).not.toHaveBeenCalled()
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('rejects a uid that does not match the applicant', async () => {
    kunParsePutBodyMock.mockResolvedValue({ messageId: 1, uid: 8 })

    const response = await PUT(request)

    await expect(response.json()).resolves.toBe('申请人与目标用户不匹配')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('rejects a message that is not a creator application', async () => {
    findMessageMock.mockResolvedValue({
      id: 1,
      type: 'feedback',
      status: 0,
      sender_id: 7
    })

    const response = await PUT(request)

    await expect(response.json()).resolves.toBe('未找到该创作者请求')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('still succeeds when the applicant was promoted meanwhile', async () => {
    // role >= 2 时 updateMany 命中 0 行不算失败, 申请照样标记通过
    updateUserMock.mockResolvedValue({ count: 0 })

    const response = await PUT(request)

    await expect(response.json()).resolves.toEqual({})
    expect(createMessageMock).toHaveBeenCalled()
  })
})
