import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunParsePostBodyMock,
  verifyHeaderCookieMock,
  findMessageMock,
  transactionMock,
  updateMessageMock,
  createMessageMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  kunParsePostBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  findMessageMock: vi.fn(),
  transactionMock: vi.fn(),
  updateMessageMock: vi.fn(),
  createMessageMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const transactionClient = {
  user_message: { updateMany: updateMessageMock }
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
  kunParsePostBody: kunParsePostBodyMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user_message: { findUnique: findMessageMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

import { POST } from '~/app/api/admin/feedback/handle/route'

const request = new Request('http://localhost/api/admin/feedback/handle', {
  method: 'POST'
}) as unknown as Parameters<typeof POST>[0]

const pendingFeedback = {
  id: 1,
  type: 'feedback',
  status: 0,
  sender_id: 7,
  content: 'kun 对「测试游戏」提交了反馈\n\n下载链接失效'
}

beforeEach(() => {
  vi.resetAllMocks()
  kunParsePostBodyMock.mockResolvedValue({
    messageId: 1,
    content: '已更换链接'
  })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 99, role: 4 })
  findMessageMock.mockResolvedValue(pendingFeedback)
  updateMessageMock.mockResolvedValue({ count: 1 })
  createMessageMock.mockResolvedValue({})
  invalidateUnreadMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      // 事务回调中途 return 字符串仍会提交, mock 须保持同一语义
      callback(transactionClient)
  )
})

describe('POST /api/admin/feedback/handle', () => {
  it('处理待办反馈: 置为已处理并通知发送者', async () => {
    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    // 幂等闸门: 仅 status=0 的反馈可命中, 状态判定收口在事务内
    expect(updateMessageMock).toHaveBeenCalledWith({
      where: { id: 1, status: 0 },
      data: { status: { set: 1 } }
    })
    expect(createMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'feedback',
        recipient_id: 7,
        content: expect.stringContaining(
          '反馈内容：下载链接失效\n处理回复：已更换链接'
        )
      }),
      transactionClient
    )
    expect(invalidateUnreadMock).toHaveBeenCalledWith(7)
  })

  it('反馈不存在时返回业务错误而非抛错', async () => {
    findMessageMock.mockResolvedValue(null)

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('未找到该反馈')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('拒绝处理非反馈类型的消息', async () => {
    findMessageMock.mockResolvedValue({ ...pendingFeedback, type: 'apply' })

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('未找到该反馈')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('拒绝处理无发送者的反馈通知行', async () => {
    // 本路由自发的「反馈已处理」通知也是 feedback 类型但 sender_id 为空,
    // 与 admin 列表 sender_id not null 的过滤对齐
    findMessageMock.mockResolvedValue({ ...pendingFeedback, sender_id: null })

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('未找到该反馈')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('闸门命中 0 行时视为已处理且不重复通知', async () => {
    updateMessageMock.mockResolvedValue({ count: 0 })

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('该反馈已被处理')
    expect(createMessageMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('处理留言为空时回退默认文案', async () => {
    kunParsePostBodyMock.mockResolvedValue({ messageId: 1, content: '' })

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    expect(createMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('处理回复：无处理留言')
      }),
      transactionClient
    )
  })
})
