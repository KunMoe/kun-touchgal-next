import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunParsePostBodyMock,
  verifyHeaderCookieMock,
  findPatchMock,
  findUserMock,
  createMessageMock
} = vi.hoisted(() => ({
  kunParsePostBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  findPatchMock: vi.fn(),
  findUserMock: vi.fn(),
  createMessageMock: vi.fn()
}))

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

vi.mock('~/prisma', () => ({
  prisma: {
    patch: { findUnique: findPatchMock },
    user: { findUnique: findUserMock }
  }
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

import { POST } from '~/app/api/patch/feedback/route'

const request = new Request('http://localhost/api/patch/feedback', {
  method: 'POST'
}) as unknown as Parameters<typeof POST>[0]

describe('POST /api/patch/feedback', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    kunParsePostBodyMock.mockResolvedValue({
      patchId: 100,
      content: '下载链接失效'
    })
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7, name: 'kun' })
    createMessageMock.mockResolvedValue({ id: 1 })
  })

  it('Galgame 不存在时返回错误, 不写入含 undefined 的反馈消息', async () => {
    findPatchMock.mockResolvedValue(null)

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('未找到 Galgame')
    expect(createMessageMock).not.toHaveBeenCalled()
  })

  it('写入的反馈消息带游戏名与跳转链接', async () => {
    findPatchMock.mockResolvedValue({ name: '测试游戏', unique_id: 'abcd1234' })

    const response = await POST(request)

    await expect(response.json()).resolves.toEqual({})
    expect(findPatchMock).toHaveBeenCalledWith({
      where: { id: 100 },
      select: { name: true, unique_id: true }
    })
    expect(createMessageMock).toHaveBeenCalledWith({
      type: 'feedback',
      content: 'kun 对「测试游戏」提交了反馈\n\n下载链接失效',
      sender_id: 7,
      link: '/abcd1234'
    })
    // 用户名取自鉴权层 (verifyAndLoadUser 已用库中最新 name 覆盖 payload),
    // 不得再查一次 user
    expect(findUserMock).not.toHaveBeenCalled()
  })

  it('未登录时不查库', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    const response = await POST(request)

    await expect(response.json()).resolves.toBe('用户未登录')
    expect(findPatchMock).not.toHaveBeenCalled()
    expect(createMessageMock).not.toHaveBeenCalled()
  })
})
