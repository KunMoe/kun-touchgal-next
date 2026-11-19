import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { getCompanyByIdMock } = vi.hoisted(() => ({
  getCompanyByIdMock: vi.fn()
}))

vi.mock('~/prisma', () => ({ prisma: {} }))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutboxBatch: vi.fn(),
  kickSearchOutboxDrain: vi.fn()
}))

vi.mock('~/app/api/company/service', () => ({
  getCompanyById: getCompanyByIdMock
}))

vi.mock('~/app/api/company/cache', () => ({
  invalidateCompanyListCache: vi.fn()
}))

import { GET } from '~/app/api/company/route'

const COMPANY = { id: 8, name: 'Key', count: 0, alias: [] }

const getRequest = (query: string) =>
  new NextRequest(`http://localhost/api/company?${query}`)

beforeEach(() => {
  vi.resetAllMocks()
})

describe('GET /api/company', () => {
  it('会社存在时返回它', async () => {
    getCompanyByIdMock.mockResolvedValue(COMPANY)

    const res = await GET(getRequest('companyId=8'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(COMPANY)
    expect(getCompanyByIdMock).toHaveBeenCalledWith({ companyId: 8 })
  })

  // 服务以 null 表达不存在; 线上协议仍是 200 + 原中文串, 文案只在路由边界产生
  it('会社不存在时返回 200 与原文案', async () => {
    getCompanyByIdMock.mockResolvedValue(null)

    const res = await GET(getRequest('companyId=9'))

    expect(res.status).toBe(200)
    expect(await res.json()).toBe('未找到公司')
  })

  it('参数非法时返回校验消息, 不查库', async () => {
    const res = await GET(getRequest('companyId=0'))

    expect(res.status).toBe(200)
    expect(typeof (await res.json())).toBe('string')
    expect(getCompanyByIdMock).not.toHaveBeenCalled()
  })
})
