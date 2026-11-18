import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { verifyHeaderCookieMock, deletePatchByIdMock, getPatchByIdMock } =
  vi.hoisted(() => ({
    verifyHeaderCookieMock: vi.fn(),
    deletePatchByIdMock: vi.fn(),
    getPatchByIdMock: vi.fn()
  }))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// 删除流程本身由 delete.test.ts 覆盖, 这里只钉路由闸门
vi.mock('~/app/api/patch/delete', () => ({
  deletePatchById: deletePatchByIdMock
}))

vi.mock('~/app/api/patch/get', () => ({
  getPatchById: getPatchByIdMock
}))

import { DELETE } from '~/app/api/patch/route'

const asPayload = (role: number) => ({ uid: 7, name: 'kun', role })

const deleteRequest = (query: string) =>
  new NextRequest(`http://localhost/api/patch?${query}`, { method: 'DELETE' })

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(asPayload(4))
  deletePatchByIdMock.mockResolvedValue({})
})

describe('DELETE /api/patch 闸门 (galgame.delete)', () => {
  it('patchId 非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await DELETE(deleteRequest('patchId=0'))

    expect(await res.json()).toBe('Too small: expected number to be >=1')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(deletePatchByIdMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不调 service', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await DELETE(deleteRequest('patchId=42'))

    expect(await res.json()).toBe('用户未登录')
    expect(deletePatchByIdMock).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3])(
    'role %i 返回 本页面仅超级管理员可访问, 不调 service',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      const res = await DELETE(deleteRequest('patchId=42'))

      expect(await res.json()).toBe('本页面仅超级管理员可访问')
      expect(deletePatchByIdMock).not.toHaveBeenCalled()
    }
  )

  it('role 4 通过闸门, 把解析后的 patchId 交给 service', async () => {
    const res = await DELETE(deleteRequest('patchId=42'))

    expect(await res.json()).toEqual({})
    expect(deletePatchByIdMock).toHaveBeenCalledTimes(1)
    expect(deletePatchByIdMock.mock.calls[0][0]).toEqual({ patchId: 42 })
  })

  it('service 返回错误串时原样返回', async () => {
    deletePatchByIdMock.mockResolvedValue('未找到该 Galgame')
    const res = await DELETE(deleteRequest('patchId=42'))

    expect(await res.json()).toBe('未找到该 Galgame')
  })
})
