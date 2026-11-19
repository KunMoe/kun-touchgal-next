import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  countMock,
  findManyMock,
  findUniqueMock,
  findFirstMock,
  visibilityMock
} = vi.hoisted(() => ({
  countMock: vi.fn(),
  findManyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  findFirstMock: vi.fn(),
  visibilityMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: {
      count: countMock,
      findMany: findManyMock,
      findUnique: findUniqueMock,
      findFirst: findFirstMock
    }
  }
}))

// kunRoute 的 optional 经 verifyHeaderCookie 读同一个上下文的 viewer
vi.mock('~/server/viewer/fromRequest', () => ({
  viewerContextFromRequest: () => ({
    visibility: visibilityMock,
    viewer: async () => null
  })
}))

import { GET } from '~/app/api/home/random/route'

const request = new Request('http://localhost') as unknown as Parameters<
  typeof GET
>[0]

describe('/api/home/random', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    visibilityMock.mockResolvedValue({ contentLimit: 'sfw', blockedTagIds: [] })
    countMock.mockResolvedValue(10)
    findManyMock.mockResolvedValue([{ id: 42 }])
    findUniqueMock.mockResolvedValue({ unique_id: 'kun00042' })
    findFirstMock.mockResolvedValue({ unique_id: 'kun00001' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns an error message when no patch is visible', async () => {
    countMock.mockResolvedValue(0)

    const response = await GET(request)

    expect(await response.json()).toBe('未查询到文章')
    expect(findManyMock).not.toHaveBeenCalled()
    expect(findFirstMock).not.toHaveBeenCalled()
  })

  it('samples by offset over id only, then resolves unique_id by id', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    const response = await GET(request)

    expect(await response.json()).toEqual({ uniqueId: 'kun00042' })
    // select 只取 id 是 Index Only Scan 的前提, 防止退回 select unique_id
    expect(findManyMock).toHaveBeenCalledWith({
      where: { content_limit: 'sfw' },
      orderBy: { id: 'asc' },
      skip: 5,
      take: 1,
      select: { id: true }
    })
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 42 },
      select: { unique_id: true }
    })
    expect(findFirstMock).not.toHaveBeenCalled()
  })

  it('falls back to findFirst when the offset row was deleted concurrently', async () => {
    findManyMock.mockResolvedValue([])

    const response = await GET(request)

    expect(await response.json()).toEqual({ uniqueId: 'kun00001' })
    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(findFirstMock).toHaveBeenCalledWith({
      where: { content_limit: 'sfw' },
      orderBy: { id: 'asc' },
      select: { unique_id: true }
    })
  })

  it('falls back to findFirst when the sampled id vanishes between the two queries', async () => {
    findUniqueMock.mockResolvedValue(null)

    const response = await GET(request)

    expect(await response.json()).toEqual({ uniqueId: 'kun00001' })
    expect(findFirstMock).toHaveBeenCalledTimes(1)
  })

  it('returns an error message when even the fallback finds nothing', async () => {
    findManyMock.mockResolvedValue([])
    findFirstMock.mockResolvedValue(null)

    const response = await GET(request)

    expect(await response.json()).toBe('未查询到文章')
  })
})
