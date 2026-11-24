import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  findFirstMock,
  findUniqueMock,
  createMock,
  transactionMock,
  invalidateMock,
  enqueueBatchMock,
  kickDrainMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  findFirstMock: vi.fn(),
  findUniqueMock: vi.fn(),
  createMock: vi.fn(),
  transactionMock: vi.fn(),
  invalidateMock: vi.fn(),
  enqueueBatchMock: vi.fn(),
  kickDrainMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// 写库逻辑内联在路由里, 由 route.test.ts 覆盖; 这里只看闸门放行后是否触达数据库
vi.mock('~/prisma', () => ({
  prisma: {
    patch_company: {
      findFirst: findFirstMock,
      findUnique: findUniqueMock,
      create: createMock
    },
    $transaction: transactionMock
  }
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutboxBatch: enqueueBatchMock,
  kickSearchOutboxDrain: kickDrainMock
}))

vi.mock('~/app/api/company/service', () => ({
  getCompanyById: vi.fn()
}))

vi.mock('~/app/api/company/cache', () => ({
  invalidateCompanyListCache: invalidateMock
}))

import { DELETE, POST, PUT } from '~/app/api/company/route'

const ADMIN_ONLY = '本页面仅管理员可访问'
const COMPANY_ID = 8
const CREATED = { id: COMPANY_ID, name: 'Key', count: 0, alias: [] }
const UPDATED = { id: COMPANY_ID, name: 'Key' }

const asPayload = (role: number) => ({ uid: 7, name: 'kun', role })

const createBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Key',
  introduction: '',
  alias: [],
  primary_language: ['ja'],
  official_website: [],
  parent_brand: [],
  ...overrides
})

const updateBody = (overrides: Record<string, unknown> = {}) => ({
  ...createBody(),
  companyId: COMPANY_ID,
  ...overrides
})

const jsonRequest = (method: 'POST' | 'PUT', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/company', {
    method,
    body: JSON.stringify(body)
  })

const deleteRequest = (query: string) =>
  new NextRequest(`http://localhost/api/company?${query}`, {
    method: 'DELETE'
  })

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(asPayload(3))
  findFirstMock.mockResolvedValue(null)
  findUniqueMock.mockResolvedValue({ name: 'Key' })
  createMock.mockResolvedValue(CREATED)
  invalidateMock.mockResolvedValue(undefined)
})

describe('POST /api/company 闸门 (company.manage)', () => {
  it('请求体非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(jsonRequest('POST', createBody({ name: '' })))

    expect(await res.json()).toBe('会社名不可为空')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(findFirstMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不查库', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toBe('用户未登录')
    expect(findFirstMock).not.toHaveBeenCalled()
  })

  it.each([1, 2])('role %i 被拒, 不查库不写库', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toBe(ADMIN_ONLY)
    expect(findFirstMock).not.toHaveBeenCalled()
    expect(createMock).not.toHaveBeenCalled()
  })

  it.each([3, 4])('role %i 通过闸门并创建会社', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await POST(jsonRequest('POST', createBody()))

    expect(await res.json()).toEqual(CREATED)
    expect(createMock).toHaveBeenCalledTimes(1)
  })
})

describe('PUT /api/company 闸门 (company.manage)', () => {
  beforeEach(() => {
    transactionMock.mockResolvedValue({ newCompany: UPDATED, patchIds: [] })
  })

  it('请求体非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await PUT(jsonRequest('PUT', updateBody({ name: '' })))

    expect(await res.json()).toBe('会社名不可为空')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不查库', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await PUT(jsonRequest('PUT', updateBody()))

    expect(await res.json()).toBe('用户未登录')
    expect(findFirstMock).not.toHaveBeenCalled()
  })

  it.each([1, 2])('role %i 被拒, 不查库不写库', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await PUT(jsonRequest('PUT', updateBody()))

    expect(await res.json()).toBe(ADMIN_ONLY)
    expect(findFirstMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it.each([3, 4])('role %i 通过闸门并更新会社', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await PUT(jsonRequest('PUT', updateBody()))

    expect(await res.json()).toEqual(UPDATED)
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })
})

describe('DELETE /api/company 闸门 (company.manage)', () => {
  beforeEach(() => {
    transactionMock.mockResolvedValue([])
  })

  it('companyId 非法时返回校验消息, 且解析先于鉴权不读会话', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await DELETE(deleteRequest('companyId=0'))

    expect(await res.json()).toBe('会社 ID 无效')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未登录, 不写库', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await DELETE(deleteRequest(`companyId=${COMPANY_ID}`))

    expect(await res.json()).toBe('用户未登录')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it.each([1, 2])('role %i 被拒, 不写库', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await DELETE(deleteRequest(`companyId=${COMPANY_ID}`))

    expect(await res.json()).toBe(ADMIN_ONLY)
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it.each([3, 4])('role %i 通过闸门并删除会社', async (role) => {
    verifyHeaderCookieMock.mockResolvedValue(asPayload(role))
    const res = await DELETE(deleteRequest(`companyId=${COMPANY_ID}`))

    expect(await res.json()).toEqual({})
    expect(transactionMock).toHaveBeenCalledTimes(1)
  })
})
