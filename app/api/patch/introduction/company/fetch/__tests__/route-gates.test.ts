import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  patchFindUniqueMock,
  companyFindManyMock,
  gatherMock,
  invalidateListMock,
  invalidateRelationMock,
  queueSearchSyncMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  patchFindUniqueMock: vi.fn(),
  companyFindManyMock: vi.fn(),
  gatherMock: vi.fn(),
  invalidateListMock: vi.fn(),
  invalidateRelationMock: vi.fn(),
  queueSearchSyncMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findUnique: patchFindUniqueMock },
    patch_company: { findMany: companyFindManyMock }
  }
}))

// 外部抓取与会社落库由 gatherCompanies.test.ts 覆盖, 这里只钉路由闸门
vi.mock('~/app/api/patch/introduction/company/_gatherCompanies', () => ({
  gatherAndEnsurePatchCompanies: gatherMock
}))

vi.mock('~/app/api/company/cache', () => ({
  invalidateCompanyListCache: invalidateListMock
}))

vi.mock('~/app/api/patch/introduction/_relationRoute', () => ({
  invalidatePatchRelationCaches: invalidateRelationMock
}))

vi.mock('~/server/search/sync', () => ({
  queueSearchSync: queueSearchSyncMock
}))

import { POST } from '~/app/api/patch/introduction/company/fetch/route'

const PATCH_ID = 42
const COMPANIES = [{ id: 8, name: 'Key', count: 3 }]

const asPayload = (role: number) => ({ uid: 7, name: 'kun', role })

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/patch/introduction/company/fetch', {
    method: 'POST',
    body: JSON.stringify(body)
  })

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
  patchFindUniqueMock.mockResolvedValue({
    unique_id: 'abcd1234',
    vndb_id: 'v1',
    bangumi_id: null,
    steam_id: null,
    dlsite_code: ''
  })
  gatherMock.mockResolvedValue({ fetched: 1, changed: false })
  companyFindManyMock.mockResolvedValue(COMPANIES)
})

describe('POST /api/patch/introduction/company/fetch 闸门 (company.manage)', () => {
  it('请求体非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(postRequest({ patchId: 0 }))

    expect(await res.json()).toBe('Too small: expected number to be >=1')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(patchFindUniqueMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不查库', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(postRequest({ patchId: PATCH_ID }))

    expect(await res.json()).toBe('用户未登录')
    expect(patchFindUniqueMock).not.toHaveBeenCalled()
  })

  // 拒绝文案与其他会社路由的 本页面仅管理员可访问 不同, 原样钉住
  it.each([1, 2])(
    'role %i 返回 您没有权限执行此操作, 不查库不抓取',
    async (role) => {
      verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
      const res = await POST(postRequest({ patchId: PATCH_ID }))

      expect(await res.json()).toBe('您没有权限执行此操作')
      expect(patchFindUniqueMock).not.toHaveBeenCalled()
      expect(gatherMock).not.toHaveBeenCalled()
    }
  )

  it.each([3, 4])('role %i 通过闸门并完成抓取', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await POST(postRequest({ patchId: PATCH_ID }))

    expect(await res.json()).toEqual({
      message: '成功关联 1 个会社',
      companies: COMPANIES
    })
    expect(gatherMock).toHaveBeenCalledTimes(1)
    expect(gatherMock.mock.calls[0][0]).toBe(PATCH_ID)
  })
})
