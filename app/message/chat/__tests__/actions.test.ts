import { beforeEach, describe, expect, it, vi } from 'vitest'

const { verifyHeaderCookieMock, getConversationMessagesMock } = vi.hoisted(
  () => ({
    verifyHeaderCookieMock: vi.fn(),
    getConversationMessagesMock: vi.fn()
  })
)

vi.mock('~/utils/actions/verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/api/message/conversation/service', () => ({
  getConversations: vi.fn()
}))

vi.mock('~/app/api/message/conversation/[id]/service', () => ({
  getConversationMessages: getConversationMessagesMock
}))

import { kunGetConversationMessagesAction } from '~/app/message/chat/actions'

const UID = 7
// 页面只做 parseInt+isNaN, 越界值曾一路裸穿到 prisma 抛 P2020 打爆 error boundary
const OVERFLOW_ID = 99999999999

describe('kunGetConversationMessagesAction 会话 ID 范围校验', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    verifyHeaderCookieMock.mockResolvedValue({ uid: UID })
    getConversationMessagesMock.mockResolvedValue({
      messages: [],
      total: 0,
      otherUser: { id: 99, name: 'kun', avatar: '' }
    })
  })

  it('会话 ID 越过 int4 时返回错误字符串, 不进入 service', async () => {
    const response = await kunGetConversationMessagesAction(OVERFLOW_ID, {
      page: 1,
      limit: 30
    })

    expect(response).toBe('无效的会话 ID')
    expect(getConversationMessagesMock).not.toHaveBeenCalled()
  })

  it('合法会话 ID 放行至 service', async () => {
    await kunGetConversationMessagesAction(12, { page: 1, limit: 30 })

    expect(getConversationMessagesMock).toHaveBeenCalledWith(
      12,
      { page: 1, limit: 30 },
      UID
    )
  })
})
