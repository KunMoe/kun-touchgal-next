import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunParseGetQueryMock,
  verifyHeaderCookieMock,
  relationFindManyMock,
  relationCountMock
} = vi.hoisted(() => ({
  kunParseGetQueryMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  relationFindManyMock: vi.fn(),
  relationCountMock: vi.fn()
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
  kunParseGetQuery: kunParseGetQueryMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user_follow_relation: {
      findMany: relationFindManyMock,
      count: relationCountMock
    }
  }
}))

import { GET as getFollowerRoute } from '~/app/api/user/follow/follower/route'
import { GET as getFollowingRoute } from '~/app/api/user/follow/following/route'

const baseInput = { uid: 7, page: 1, limit: 2 }
const currentUserUid = 99

type MockFindManyArgs = {
  where?: {
    following_id?: number | { in?: number[] }
    follower_id?: number
  }
  select?: {
    follower?: unknown
    following?: unknown
  }
}

const mockRequest = new Request('http://localhost') as unknown as Parameters<
  typeof getFollowerRoute
>[0]

const seedFollowerQuery = () => {
  relationFindManyMock.mockImplementation(async (args: MockFindManyArgs) => {
    if (args.where?.following_id === baseInput.uid && args.select?.follower) {
      return [
        {
          follower: {
            id: 11,
            name: 'Alice',
            avatar: '/alice.webp',
            bio: 'alpha',
            _count: { follower: 3, following: 1 }
          }
        },
        {
          follower: {
            id: 12,
            name: 'Bob',
            avatar: '/bob.webp',
            bio: 'beta',
            _count: { follower: 4, following: 0 }
          }
        }
      ]
    }

    const followingIdFilter = args.where?.following_id
    if (
      args.where?.follower_id === currentUserUid &&
      typeof followingIdFilter === 'object' &&
      Array.isArray(followingIdFilter?.in)
    ) {
      return [{ following_id: 11 }]
    }

    return []
  })
}

const seedFollowingQuery = () => {
  relationFindManyMock.mockImplementation(async (args: MockFindManyArgs) => {
    if (args.where?.follower_id === baseInput.uid && args.select?.following) {
      return [
        {
          following: {
            id: 21,
            name: 'Carol',
            avatar: '/carol.webp',
            bio: 'gamma',
            _count: { follower: 8, following: 2 }
          }
        },
        {
          following: {
            id: 22,
            name: 'Dave',
            avatar: '/dave.webp',
            bio: 'delta',
            _count: { follower: 5, following: 0 }
          }
        }
      ]
    }

    const followingIdFilter = args.where?.following_id
    if (
      args.where?.follower_id === currentUserUid &&
      typeof followingIdFilter === 'object' &&
      Array.isArray(followingIdFilter?.in)
    ) {
      return [{ following_id: 21 }]
    }

    return []
  })
}

beforeEach(() => {
  kunParseGetQueryMock.mockReset()
  verifyHeaderCookieMock.mockReset()
  relationFindManyMock.mockReset()
  relationCountMock.mockReset()

  kunParseGetQueryMock.mockReturnValue(baseInput)
  verifyHeaderCookieMock.mockResolvedValue({ uid: currentUserUid })
  relationCountMock.mockResolvedValue(2)
})

describe('GET /api/user/follow/follower', () => {
  it('主列表查询只抓最小 user 字段 + DB 侧计数', async () => {
    seedFollowerQuery()

    const response = await getFollowerRoute(mockRequest)
    await response.json()

    expect(relationFindManyMock).toHaveBeenNthCalledWith(1, {
      take: 2,
      skip: 0,
      where: { following_id: 7 },
      select: {
        follower: {
          select: {
            id: true,
            name: true,
            avatar: true,
            bio: true,
            _count: {
              select: {
                follower: true,
                following: true
              }
            }
          }
        }
      }
    })
  })

  it('用单独批量查询计算当前用户 isFollow', async () => {
    seedFollowerQuery()

    const response = await getFollowerRoute(mockRequest)
    const body = await response.json()

    expect(relationFindManyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          follower_id: currentUserUid,
          following_id: { in: [11, 12] }
        }
      })
    )
    expect(body).toEqual({
      total: 2,
      followers: [
        expect.objectContaining({ id: 11, isFollow: true }),
        expect.objectContaining({ id: 12, isFollow: false })
      ]
    })
  })
})

describe('GET /api/user/follow/following', () => {
  it('主列表查询只抓最小 user 字段 + DB 侧计数', async () => {
    seedFollowingQuery()

    const response = await getFollowingRoute(mockRequest)
    await response.json()

    expect(relationFindManyMock).toHaveBeenNthCalledWith(1, {
      take: 2,
      skip: 0,
      where: { follower_id: 7 },
      select: {
        following: {
          select: {
            id: true,
            name: true,
            avatar: true,
            bio: true,
            _count: {
              select: {
                follower: true,
                following: true
              }
            }
          }
        }
      }
    })
  })

  it('用单独批量查询计算当前用户 isFollow', async () => {
    seedFollowingQuery()

    const response = await getFollowingRoute(mockRequest)
    const body = await response.json()

    expect(relationFindManyMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          follower_id: currentUserUid,
          following_id: { in: [21, 22] }
        }
      })
    )
    expect(body).toEqual({
      total: 2,
      followings: [
        expect.objectContaining({ id: 21, isFollow: true }),
        expect.objectContaining({ id: 22, isFollow: false })
      ]
    })
  })
})

// 关注关系图只给登录用户看 (X02-02): 游客在查询之前就被拦下
describe.each([
  ['follower', getFollowerRoute],
  ['following', getFollowingRoute]
])('GET /api/user/follow/%s 游客', (_name, route) => {
  it('返回 用户未登录, 不查关注关系', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    const response = await route(mockRequest)

    await expect(response.json()).resolves.toBe('用户未登录')
    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(relationCountMock).not.toHaveBeenCalled()
  })
})
