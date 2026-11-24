import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// 走真实的 kunRoute 与解析器。小数 uid 放行的话, 删号服务里「请勿删除自己」的守卫拿 5.5 与
// 5 比较不相等, Prisma 又把 5.5 截成 5: 管理员按自身 uid + 0.5 删掉的是自己

const { verifyHeaderCookieMock, deleteAccountMock } = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  deleteAccountMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))
vi.mock('~/server/account/deleteAccount', () => ({
  deleteAccount: deleteAccountMock
}))

import { DELETE } from '~/app/api/admin/user/route'

const del = (query: string) =>
  new NextRequest(`http://localhost/api/admin/user?${query}`, {
    method: 'DELETE'
  })

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 5, role: 4, name: 'root' })
  deleteAccountMock.mockResolvedValue({})
})

describe('DELETE /api/admin/user 的 uid 必须是整数', () => {
  it('自身 uid + 0.5 被拒, 不进删号服务', async () => {
    const res = await DELETE(del('uid=5.5'))

    expect(await res.json()).toBe('用户 ID 无效')
    expect(deleteAccountMock).not.toHaveBeenCalled()
  })

  it('整数 uid 原样交给删号服务', async () => {
    await DELETE(del('uid=6'))

    expect(deleteAccountMock).toHaveBeenCalledWith(
      6,
      expect.objectContaining({ uid: 5 })
    )
  })
})
