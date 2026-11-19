import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  parseGetMock,
  parsePostMock,
  parsePutMock,
  parseDeleteMock,
  verifyHeaderCookieMock,
  findFirstMock,
  findUniqueMock,
  createMock,
  updateMock,
  deleteMock,
  relationFindManyMock,
  transactionMock,
  invalidateMock,
  enqueueBatchMock,
  kickDrainMock,
  tx
} = vi.hoisted(() => {
  const updateMock = vi.fn()
  const deleteMock = vi.fn()
  const relationFindManyMock = vi.fn()
  return {
    parseGetMock: vi.fn(),
    parsePostMock: vi.fn(),
    parsePutMock: vi.fn(),
    parseDeleteMock: vi.fn(),
    verifyHeaderCookieMock: vi.fn(),
    findFirstMock: vi.fn(),
    findUniqueMock: vi.fn(),
    createMock: vi.fn(),
    updateMock,
    deleteMock,
    relationFindManyMock,
    transactionMock: vi.fn(),
    invalidateMock: vi.fn(),
    enqueueBatchMock: vi.fn(),
    kickDrainMock: vi.fn(),
    tx: {
      patch_company: { update: updateMock, delete: deleteMock },
      patch_company_relation: { findMany: relationFindManyMock }
    }
  }
})

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParseGetQuery: parseGetMock,
  kunParsePostBody: parsePostMock,
  kunParsePutBody: parsePutMock,
  kunParseDeleteQuery: parseDeleteMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

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

import { Prisma } from '~/prisma/generated/prisma/client'
import { DELETE, POST, PUT } from '~/app/api/company/route'

const CREATE_INPUT = {
  name: 'Key',
  primary_language: ['ja'],
  introduction: '',
  alias: [],
  official_website: [],
  parent_brand: []
}
const COMPANY = { id: 1, name: 'Key', count: 0, alias: [] }
const request = new Request('http://localhost') as unknown as Parameters<
  typeof POST
>[0]

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 7, role: 3 })
  findFirstMock.mockResolvedValue(null)
  findUniqueMock.mockResolvedValue({ name: 'Key-old' })
  createMock.mockResolvedValue(COMPANY)
  updateMock.mockResolvedValue(COMPANY)
  deleteMock.mockResolvedValue(COMPANY)
  relationFindManyMock.mockResolvedValue([{ patch_id: 11 }, { patch_id: 12 }])
  transactionMock.mockImplementation(async (fn) => fn(tx))
  invalidateMock.mockResolvedValue(undefined)
  enqueueBatchMock.mockResolvedValue(undefined)
  parsePostMock.mockResolvedValue(CREATE_INPUT)
  parsePutMock.mockResolvedValue({ ...CREATE_INPUT, companyId: 1 })
  parseDeleteMock.mockReturnValue({ companyId: 1 })
})

describe('company list cache invalidation', () => {
  it('invalidates only after a company is created', async () => {
    const events: string[] = []
    createMock.mockImplementation(async () => {
      events.push('database-write')
      return COMPANY
    })
    invalidateMock.mockImplementation(async () => {
      events.push('cache-invalidation')
    })

    const response = await POST(request)

    expect(await response.json()).toEqual(COMPANY)
    expect(events).toEqual(['database-write', 'cache-invalidation'])
  })

  it('does not invalidate when creation finds an existing company', async () => {
    findFirstMock.mockResolvedValue(COMPANY)

    const response = await POST(request)

    expect(await response.json()).toBe('这个会社已经存在了')
    expect(createMock).not.toHaveBeenCalled()
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('invalidates after a company update succeeds', async () => {
    await PUT(request)

    expect(updateMock).toHaveBeenCalledTimes(1)
    expect(invalidateMock).toHaveBeenCalledTimes(1)
  })

  it('returns the duplicate message when a concurrent rename hits the unique index', async () => {
    updateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test'
      })
    )

    const response = await PUT(request)

    expect(await response.json()).toBe('这个会社已经存在了')
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('invalidates after a company deletion succeeds', async () => {
    await DELETE(request)

    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 1 } })
    expect(invalidateMock).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate when the database write fails', async () => {
    createMock.mockRejectedValue(new Error('database down'))

    await expect(POST(request)).rejects.toThrow('database down')
    expect(invalidateMock).not.toHaveBeenCalled()
  })
})

describe('company search index sync', () => {
  it('rename enqueues all related patches inside the tx and kicks drain', async () => {
    await PUT(request)

    expect(relationFindManyMock).toHaveBeenCalledWith({
      where: { company_id: 1 },
      select: { patch_id: true }
    })
    // 入队作用在事务 tx 上，与会社变更原子提交
    expect(enqueueBatchMock).toHaveBeenCalledWith(tx, [11, 12])
    expect(kickDrainMock).toHaveBeenCalledTimes(1)
  })

  it('update without rename enqueues nothing and does not kick', async () => {
    findUniqueMock.mockResolvedValue({ name: 'Key' })

    await PUT(request)

    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(enqueueBatchMock).toHaveBeenCalledWith(tx, [])
    expect(kickDrainMock).not.toHaveBeenCalled()
  })

  it('delete reads relations before deletion, enqueues and kicks', async () => {
    const events: string[] = []
    relationFindManyMock.mockImplementation(async () => {
      events.push('relation-read')
      return [{ patch_id: 11 }, { patch_id: 12 }]
    })
    deleteMock.mockImplementation(async () => {
      events.push('company-delete')
      return COMPANY
    })

    await DELETE(request)

    // Cascade 会随删除清掉关系行，关联 patch 必须在删除前读取
    expect(events).toEqual(['relation-read', 'company-delete'])
    expect(enqueueBatchMock).toHaveBeenCalledWith(tx, [11, 12])
    expect(kickDrainMock).toHaveBeenCalledTimes(1)
  })

  it('delete failure rolls back without kicking drain', async () => {
    deleteMock.mockRejectedValue(new Error('not found'))

    const response = await DELETE(request)

    expect(await response.json()).toBe('未找到对应的会社')
    expect(kickDrainMock).not.toHaveBeenCalled()
    expect(invalidateMock).not.toHaveBeenCalled()
  })
})
