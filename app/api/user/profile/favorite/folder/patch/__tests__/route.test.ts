import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  parseGetMock,
  verifyHeaderCookieMock,
  findUniqueMock,
  countMock,
  findManyMock
} = vi.hoisted(() => ({
  parseGetMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  findUniqueMock: vi.fn(),
  countMock: vi.fn(),
  findManyMock: vi.fn()
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
  kunParseGetQuery: parseGetMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user_patch_favorite_folder: {
      findUnique: findUniqueMock
    },
    user_patch_favorite_folder_relation: {
      count: countMock,
      findMany: findManyMock
    }
  }
}))

import { GET } from '~/app/api/user/profile/favorite/folder/patch/route'

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof GET
>[0]

const publicFolder = { id: 7, user_id: 42, is_public: true }

const relationRow = {
  patch: {
    id: 11,
    unique_id: 'abc',
    name: '测试 Galgame',
    banner: 'banner.avif',
    view: 3,
    download: 5,
    type: ['patch'],
    language: ['ja'],
    platform: ['windows'],
    created: new Date('2026-09-15T00:00:00.000Z'),
    favorite_count: 1,
    resource_count: 2,
    comment_count: 3,
    rating_stat: { avg_overall: 4.26 }
  }
}

const flushMicrotasks = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  parseGetMock.mockReturnValue({ folderId: 7, page: 1, limit: 24 })
  verifyHeaderCookieMock.mockResolvedValue({ uid: 42 })
  findUniqueMock.mockResolvedValue(publicFolder)
  countMock.mockResolvedValue(1)
  findManyMock.mockResolvedValue([relationRow])
})

describe('GET /api/user/profile/favorite/folder/patch', () => {
  it('dispatches count and findMany in parallel', async () => {
    // 两条都挂起才能锁死并行: 只挂 count 的话, 把两条 await 顺序颠倒的串行
    // 形态（先 findMany 后 count）同样能让 findMany 被调用, 测试会假绿
    countMock.mockReturnValue(new Promise(() => {}))
    findManyMock.mockReturnValue(new Promise(() => {}))

    void GET(mockRequest)
    await flushMicrotasks()

    expect(countMock).toHaveBeenCalledTimes(1)
    expect(findManyMock).toHaveBeenCalledTimes(1)
  })

  it('returns the paginated cards with total', async () => {
    const res = await GET(mockRequest)

    await expect(res.json()).resolves.toEqual({
      total: 1,
      patches: [
        {
          id: 11,
          uniqueId: 'abc',
          name: '测试 Galgame',
          banner: 'banner.avif',
          view: 3,
          download: 5,
          type: ['patch'],
          language: ['ja'],
          platform: ['windows'],
          created: '2026-09-15T00:00:00.000Z',
          _count: { favorite_folder: 1, resource: 2, comment: 3 },
          averageRating: 4.3
        }
      ]
    })
    expect(countMock).toHaveBeenCalledWith({ where: { folder_id: 7 } })
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { folder_id: 7 },
        skip: 0,
        take: 24
      })
    )
  })

  it('rejects a missing folder without querying relations', async () => {
    findUniqueMock.mockResolvedValue(null)

    const res = await GET(mockRequest)
    await expect(res.json()).resolves.toBe('未找到该文件夹')
    expect(countMock).not.toHaveBeenCalled()
    expect(findManyMock).not.toHaveBeenCalled()
  })

  it('rejects a private folder owned by someone else', async () => {
    findUniqueMock.mockResolvedValue({ id: 7, user_id: 43, is_public: false })

    const res = await GET(mockRequest)
    await expect(res.json()).resolves.toBe('您无权查看该私密文件夹')
    expect(countMock).not.toHaveBeenCalled()
    expect(findManyMock).not.toHaveBeenCalled()
  })

  it('returns the validation message when the query is invalid', async () => {
    parseGetMock.mockReturnValue('文件夹 ID 不合法')

    const res = await GET(mockRequest)
    await expect(res.json()).resolves.toBe('文件夹 ID 不合法')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
  })
})
