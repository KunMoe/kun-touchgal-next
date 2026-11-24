import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// 走真实的 kunRoute 与解析器。id 只有 .int().positive() 时, (int4 上界, 2^53) 之间的值直达
// Prisma 抛 P2020, PUT / DELETE 返回无 body 的 500 (F06-01)。应在边界返回业务错误

const { verifyHeaderCookieMock, updateOidcClientMock, deleteOidcClientMock } =
  vi.hoisted(() => ({
    verifyHeaderCookieMock: vi.fn(),
    updateOidcClientMock: vi.fn(),
    deleteOidcClientMock: vi.fn()
  }))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))
vi.mock('~/app/api/admin/oidc/service', () => ({
  createOidcClient: vi.fn(),
  getOidcClients: vi.fn(),
  updateOidcClient: updateOidcClientMock,
  deleteOidcClient: deleteOidcClientMock
}))

import { DELETE, PUT } from '~/app/api/admin/oidc/route'

const client = {
  client_name: 'app',
  redirect_uris: ['https://app.example/callback'],
  scopes: ['openid']
}

const put = (body: unknown) =>
  new NextRequest('http://localhost/api/admin/oidc', {
    method: 'PUT',
    body: JSON.stringify(body)
  })

const del = (query: string) =>
  new NextRequest(`http://localhost/api/admin/oidc?${query}`, {
    method: 'DELETE'
  })

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 4, name: 'root' })
  updateOidcClientMock.mockResolvedValue({})
  deleteOidcClientMock.mockResolvedValue({})
})

describe('/api/admin/oidc 的 id 不超过 int4', () => {
  it.each([2147483648, 1.5])('PUT: id=%j 返回业务错误', async (id) => {
    const res = await PUT(put({ ...client, id }))

    expect(res.status).toBe(200)
    expect(await res.json()).toBe('OIDC 客户端 ID 无效')
    expect(updateOidcClientMock).not.toHaveBeenCalled()
  })

  it.each(['2147483648', '1.5'])('DELETE: id=%s 返回业务错误', async (id) => {
    const res = await DELETE(del(`id=${id}`))

    expect(res.status).toBe(200)
    expect(await res.json()).toBe('OIDC 客户端 ID 无效')
    expect(deleteOidcClientMock).not.toHaveBeenCalled()
  })

  it('int4 上界本身照常交给服务', async () => {
    await PUT(put({ ...client, id: 2147483647 }))
    await DELETE(del('id=2147483647'))

    expect(updateOidcClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2147483647 })
    )
    expect(deleteOidcClientMock).toHaveBeenCalledWith(2147483647)
  })
})
