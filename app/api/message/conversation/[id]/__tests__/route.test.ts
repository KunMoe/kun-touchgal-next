import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  verifyHeaderCookieMock,
  getConversationMessagesMock,
  sendMessageMock,
  updateMessageMock,
  deleteConversationMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  getConversationMessagesMock: vi.fn(),
  sendMessageMock: vi.fn(),
  updateMessageMock: vi.fn(),
  deleteConversationMock: vi.fn()
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

vi.mock('~/app/api/message/conversation/[id]/service', () => ({
  getConversationMessages: getConversationMessagesMock,
  sendMessage: sendMessageMock,
  updateMessage: updateMessageMock,
  deleteMessage: vi.fn(),
  deleteConversation: deleteConversationMock
}))

import {
  GET,
  POST,
  PUT,
  DELETE
} from '~/app/api/message/conversation/[id]/route'

const UID = 7
// 超出 int4 后 prisma 对 Int 主键抛 P2020, 必须在 handler 就截断
const OVERFLOW_ID = '99999999999'

const reqUrl = (id: string, query = '') =>
  `http://localhost/api/message/conversation/${id}${query}`

describe('conversation/[id] 路径段范围校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyHeaderCookieMock.mockResolvedValue({ uid: UID })
  })

  it('GET 在会话 ID 越过 int4 时拒绝, 不进入 service', async () => {
    const res = await GET(
      { url: reqUrl(OVERFLOW_ID, '?page=1&limit=30') } as never,
      { params: Promise.resolve({ id: OVERFLOW_ID }) }
    )

    expect(await res.json()).toBe('无效的会话 ID')
    expect(getConversationMessagesMock).not.toHaveBeenCalled()
  })

  it('POST 在会话 ID 越过 int4 时拒绝, 不进入 service', async () => {
    const res = await POST(
      { json: async () => ({ content: 'kun' }) } as never,
      { params: Promise.resolve({ id: OVERFLOW_ID }) }
    )

    expect(await res.json()).toBe('无效的会话 ID')
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it('PUT 在会话 ID 越过 int4 时拒绝, 不进入 service', async () => {
    const res = await PUT(
      { json: async () => ({ messageId: 1, content: 'kun' }) } as never,
      { params: Promise.resolve({ id: OVERFLOW_ID }) }
    )

    expect(await res.json()).toBe('无效的会话 ID')
    expect(updateMessageMock).not.toHaveBeenCalled()
  })

  it('DELETE 在会话 ID 越过 int4 时拒绝, 不进入 service', async () => {
    const res = await DELETE(
      { url: reqUrl(OVERFLOW_ID, '?action=conversation') } as never,
      { params: Promise.resolve({ id: OVERFLOW_ID }) }
    )

    expect(await res.json()).toBe('无效的会话 ID')
    expect(deleteConversationMock).not.toHaveBeenCalled()
  })

  it('非数字路径段仍然拒绝', async () => {
    const res = await GET({ url: reqUrl('kun', '?page=1&limit=30') } as never, {
      params: Promise.resolve({ id: 'kun' })
    })

    expect(await res.json()).toBe('无效的会话 ID')
    expect(getConversationMessagesMock).not.toHaveBeenCalled()
  })

  it('合法会话 ID 放行, 且以 number 而非字符串传入 service', async () => {
    await GET({ url: reqUrl('12', '?page=1&limit=30') } as never, {
      params: Promise.resolve({ id: '12' })
    })

    expect(getConversationMessagesMock).toHaveBeenCalledWith(
      12,
      { page: 1, limit: 30 },
      UID
    )
  })
})
