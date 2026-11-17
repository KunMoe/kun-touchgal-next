import { beforeEach, describe, expect, it, vi } from 'vitest'

const { countMock, rootFindManyMock, likeFindManyMock, queryRawMock } =
  vi.hoisted(() => ({
    countMock: vi.fn(),
    rootFindManyMock: vi.fn(),
    likeFindManyMock: vi.fn(),
    queryRawMock: vi.fn()
  }))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: {
      count: countMock,
      findMany: rootFindManyMock,
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    user_patch_comment_like_relation: {
      findMany: likeFindManyMock
    },
    $queryRaw: queryRawMock
  }
}))

vi.mock('~/app/api/utils/render/markdownToHtmlComment', () => ({
  COMMENT_HTML_VERSION: 1
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdown: vi.fn(async (_profile: string, markdown: string) => ({
    ok: true,
    html: `<p>${markdown}</p>`,
    version: 1
  }))
}))

// 直通缓存层, 使断言只针对查询构造
vi.mock('~/app/api/patch/comment/cache', () => ({
  withPatchCommentPageCache: vi.fn(
    async (
      _patchId: number,
      _resourceId: number | null,
      _page: number,
      _limit: number,
      query: () => Promise<unknown>
    ) => query()
  ),
  invalidatePatchCommentCache: vi.fn()
}))

import { getPatchComment } from '~/app/api/patch/comment/get'

const viewer = { uid: 7, role: 1 }

beforeEach(() => {
  vi.clearAllMocks()
  // where.status === 1 是 bypass 检查 (用户自己的待审评论数), 其余计数返回 1
  countMock.mockImplementation(
    async ({ where }: { where: { status?: number } }) =>
      where.status === 1 ? 0 : 1
  )
  rootFindManyMock.mockResolvedValue([])
  likeFindManyMock.mockResolvedValue([])
  queryRawMock.mockResolvedValue([])
})

describe('getPatchComment 资源维度过滤', () => {
  it('游戏评论区的根评论查询过滤 resource_id IS NULL', async () => {
    await getPatchComment({ patchId: 10, page: 1, limit: 10 }, viewer)

    expect(rootFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          patch_id: 10,
          parent_id: null,
          resource_id: null
        })
      })
    )
  })

  it('资源评论区的根评论查询过滤对应 resource_id', async () => {
    await getPatchComment(
      { patchId: 10, resourceId: 5, page: 1, limit: 10 },
      viewer
    )

    expect(rootFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          patch_id: 10,
          parent_id: null,
          resource_id: 5
        })
      })
    )
  })

  it('commentId 深链的目标评论不属于请求上下文时回退请求页', async () => {
    // 目标评论的根属于资源 5 的评论区, 但请求的是游戏评论区
    queryRawMock.mockResolvedValueOnce([
      {
        id: 100,
        patch_id: 10,
        parent_id: null,
        resource_id: 5,
        created: new Date('2026-01-01T00:00:00.000Z')
      }
    ])

    const result = await getPatchComment(
      { patchId: 10, page: 3, limit: 10, commentId: 100 },
      viewer
    )

    expect(result.currentPage).toBe(3)
  })

  it('commentId 深链在同一资源评论区内正常换算页码', async () => {
    queryRawMock.mockResolvedValueOnce([
      {
        id: 100,
        patch_id: 10,
        parent_id: null,
        resource_id: 5,
        created: new Date('2026-01-01T00:00:00.000Z')
      }
    ])
    // 定位 count = 0 → 第 1 页; bypass 检查仍返回 0
    countMock.mockImplementation(
      async ({ where }: { where: { status?: number; AND?: unknown } }) => {
        if (where.status === 1) {
          return 0
        }
        return where.AND ? 0 : 1
      }
    )

    const result = await getPatchComment(
      { patchId: 10, resourceId: 5, page: 3, limit: 10, commentId: 100 },
      viewer
    )

    expect(result.currentPage).toBe(1)
    // 换算页码的 count 也限定在资源维度
    expect(countMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ resource_id: 5, parent_id: null })
      })
    )
  })
})
