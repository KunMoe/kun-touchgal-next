import { beforeEach, describe, expect, it, vi } from 'vitest'
import { matchesContentWhere } from '~/app/api/utils/__tests__/contentWhere'
import type { ContentWhereRow } from '~/app/api/utils/__tests__/contentWhere'

const { parseGetMock, verifyHeaderCookieMock, findFirstMock } = vi.hoisted(
  () => ({
    parseGetMock: vi.fn(),
    verifyHeaderCookieMock: vi.fn(),
    findFirstMock: vi.fn()
  })
)

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

vi.mock('~/prisma', () => ({
  prisma: {
    patch_comment: {
      findFirst: findFirstMock
    }
  }
}))

import { GET } from '~/app/api/patch/comment/markdown/route'

const request = new Request('http://localhost') as unknown as Parameters<
  typeof GET
>[0]

describe('comment markdown endpoint visibility gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    parseGetMock.mockReturnValue({ commentId: 42 })
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7, role: 1 })
    findFirstMock.mockResolvedValue({ content: 'hi', is_spoiler: false })
  })

  it('rejects unauthenticated callers without touching the database', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    const response = await GET(request)

    expect(await response.json()).toBe('用户未登录')
    expect(findFirstMock).not.toHaveBeenCalled()
  })

  // 查询条件按语义比: 在几种行上求值, 看哪些行会被取到
  const fetched = (row: ContentWhereRow) => {
    const [args] = findFirstMock.mock.calls[0]
    expect(args.select).toEqual({ content: true, is_spoiler: true })
    return matchesContentWhere(args.where, { id: 42, ...row })
  }

  it('restricts an anonymous-role viewer to public comments only', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 0, role: 0 })

    await GET(request)

    expect(fetched({ status: 0, user_id: 5 })).toBe(true)
    expect(fetched({ status: 1, user_id: 5 })).toBe(false)
    expect(fetched({ status: 2, user_id: 5 })).toBe(false)
    expect(fetched({ id: 43, status: 0, user_id: 5 })).toBe(false)
  })

  it('lets a logged-in user see public comments and their own pending ones', async () => {
    await GET(request)

    expect(fetched({ status: 0, user_id: 5 })).toBe(true)
    expect(fetched({ status: 1, user_id: 7 })).toBe(true)
    expect(fetched({ status: 1, user_id: 5 })).toBe(false)
    expect(fetched({ status: 2, user_id: 7 })).toBe(false)
  })

  it('lets an admin see public and pending comments but not hidden ones', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 9, role: 3 })

    await GET(request)

    expect(fetched({ status: 0, user_id: 5 })).toBe(true)
    expect(fetched({ status: 1, user_id: 5 })).toBe(true)
    expect(fetched({ status: 2, user_id: 5 })).toBe(false)
  })

  // X02-04: 评论区随所属资源关闭, 取原文同样按不存在处理
  it.each([
    ['游戏评论区', null, true],
    ['公开的资源', { status: 0, user_id: 5 }, true],
    ['隐藏的资源', { status: 1, user_id: 7 }, false],
    ['他人待审的资源', { status: 3, user_id: 5 }, false],
    ['自己待初审的资源', { status: 2, user_id: 7 }, true]
  ])(
    'does not return comments under a resource the viewer cannot see: %s',
    async (_name, resource, open) => {
      await GET(request)

      expect(
        fetched({
          status: 0,
          user_id: 7,
          resource_id: resource ? 5 : null,
          resource
        })
      ).toBe(open)
    }
  )

  it('returns empty content when the visibility filter excludes the comment', async () => {
    findFirstMock.mockResolvedValue(null)

    const response = await GET(request)

    expect(await response.json()).toEqual({ content: '', isSpoiler: false })
  })

  it('returns the markdown source when the comment is visible', async () => {
    findFirstMock.mockResolvedValue({
      content: 'secret draft',
      is_spoiler: true
    })

    const response = await GET(request)

    expect(await response.json()).toEqual({
      content: 'secret draft',
      isSpoiler: true
    })
  })
})
