import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// P28-03: 私聊列表曾用本页的 unreadCount 推导全局私聊红点, 未读会话不在本页时把红点清掉。
// 列表接口顺带返回该用户的全局未读快照; 未读查不到时给时刻为 0 的空快照, 列表照常返回

const { verifyHeaderCookieMock, getConversationsMock, getUnreadMock } =
  vi.hoisted(() => ({
    verifyHeaderCookieMock: vi.fn(),
    getConversationsMock: vi.fn(),
    getUnreadMock: vi.fn()
  }))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))
vi.mock('~/app/api/message/conversation/service', () => ({
  getConversations: getConversationsMock,
  getOrCreateConversation: vi.fn()
}))
vi.mock('~/app/api/message/unread/service', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('~/app/api/message/unread/service')
  >()),
  getUnreadMessageStatus: getUnreadMock
}))

import { GET } from '~/app/api/message/conversation/route'

const get = () =>
  new NextRequest('http://localhost/api/message/conversation?page=2&limit=30')

const LIST = { conversations: [], total: 31 }

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 5, role: 1, name: 'kun' })
  getConversationsMock.mockResolvedValue(LIST)
})

describe('GET /api/message/conversation 顺带返回全局未读', () => {
  it('第 2 页没有未读会话, 未读仍取该用户的全局快照', async () => {
    const unread = {
      hasUnreadNotification: false,
      hasUnreadConversation: true,
      asOf: 42
    }
    getUnreadMock.mockResolvedValue(unread)

    const res = await GET(get())

    expect(getConversationsMock).toHaveBeenCalledWith({ page: 2, limit: 30 }, 5)
    expect(getUnreadMock).toHaveBeenCalledWith(5)
    expect(await res.json()).toEqual({ ...LIST, unread })
  })

  it('未读查不到: 列表照常返回, 未读是时刻为 0 的空快照', async () => {
    getUnreadMock.mockRejectedValue(new Error('pg timeout'))

    const res = await GET(get())

    expect(await res.json()).toEqual({
      ...LIST,
      unread: {
        hasUnreadNotification: false,
        hasUnreadConversation: false,
        asOf: 0
      }
    })
  })
})
