import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  userFindUniqueMock,
  messageFindFirstMock,
  createMessageMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  messageFindFirstMock: vi.fn(),
  createMessageMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock },
    user_message: { findFirst: messageFindFirstMock }
  }
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

import { POST } from '~/app/api/apply/route'

const UID = 7
const TOO_FEW_RESOURCES = '您暂时不可以申请成为创作者, 您可以继续发布资源'
const ALREADY_CREATOR = '您已经是一名创作者了! 无需重复申请'

const asPayload = (role: number) => ({ uid: UID, name: 'kun', role })

const asUserRow = (role: number, resourceCount: number) => ({
  id: UID,
  role,
  _count: { patch_resource: resourceCount }
})

const postRequest = () =>
  new NextRequest('http://localhost/api/apply', { method: 'POST' })

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(asPayload(1))
  userFindUniqueMock.mockResolvedValue(asUserRow(1, 3))
  messageFindFirstMock.mockResolvedValue(null)
  createMessageMock.mockResolvedValue({})
})

describe('POST /api/apply 申请创作者的闸门', () => {
  it('未登录返回 用户未登录, 不查库', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(postRequest())

    expect(await res.json()).toBe('用户未登录')
    expect(userFindUniqueMock).not.toHaveBeenCalled()
  })

  it('用户行不存在返回 未找到该用户', async () => {
    userFindUniqueMock.mockResolvedValue(null)
    const res = await POST(postRequest())

    expect(await res.json()).toBe('未找到该用户')
    expect(userFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: UID } })
    )
  })

  it('资源数为 3 时 role 1 提交申请', async () => {
    const res = await POST(postRequest())

    expect(await res.json()).toEqual({})
    expect(createMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'apply', sender_id: UID })
    )
  })

  it.each([2, 3, 4])(
    '资源数为 3 时 role %i 返回 已经是创作者, 不发申请',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      userFindUniqueMock.mockResolvedValue(asUserRow(role, 3))
      const res = await POST(postRequest())

      expect(await res.json()).toBe(ALREADY_CREATOR)
      expect(messageFindFirstMock).not.toHaveBeenCalled()
      expect(createMessageMock).not.toHaveBeenCalled()
    }
  )

  it.each([1, 2, 3, 4])(
    '资源数为 2 时 role %i 先得到资源不足的消息 (资源数检查先于创作者检查)',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      userFindUniqueMock.mockResolvedValue(asUserRow(role, 2))
      const res = await POST(postRequest())

      expect(await res.json()).toBe(TOO_FEW_RESOURCES)
      expect(createMessageMock).not.toHaveBeenCalled()
    }
  )

  it('创作者检查按库内 role: 会话 role 1、库内 role 2 被拒', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(1))
    userFindUniqueMock.mockResolvedValue(asUserRow(2, 3))
    const res = await POST(postRequest())

    expect(await res.json()).toBe(ALREADY_CREATOR)
  })

  it('创作者检查按库内 role: 会话 role 2、库内 role 1 放行', async () => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(2))
    userFindUniqueMock.mockResolvedValue(asUserRow(1, 3))
    const res = await POST(postRequest())

    expect(await res.json()).toEqual({})
    expect(createMessageMock).toHaveBeenCalledTimes(1)
  })

  it('已有进行中的申请时返回等待提示, 不重复发申请', async () => {
    messageFindFirstMock.mockResolvedValue({ id: 1 })
    const res = await POST(postRequest())

    expect(await res.json()).toBe(
      '您有一条正在进行中的申请, 请等待该申请的完成'
    )
    expect(messageFindFirstMock).toHaveBeenCalledWith({
      where: { type: 'apply', sender_id: UID, status: 0 }
    })
    expect(createMessageMock).not.toHaveBeenCalled()
  })
})
