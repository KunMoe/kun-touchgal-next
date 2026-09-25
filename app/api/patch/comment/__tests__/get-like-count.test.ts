import { beforeEach, describe, expect, it, vi } from 'vitest'

const { countMock, findManyMock, queryRawMock } = vi.hoisted(() => ({
  countMock: vi.fn(),
  findManyMock: vi.fn(),
  queryRawMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: {
      count: countMock,
      findMany: findManyMock
    },
    $queryRaw: queryRawMock
  }
}))

vi.mock('~/app/api/utils/render/markdownToHtmlComment', () => ({
  COMMENT_HTML_VERSION: 1,
  markdownToHtmlComment: vi.fn(async (markdown: string) => `<p>${markdown}</p>`)
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

// 游客视角: 不查 bypass 计数, 也不叠加 isLike
const guest = { uid: 0, role: 0 }

const commentRow = (id: number, parentId: number | null, likes: number) => ({
  id,
  content: `评论${id}`,
  content_html: `<p>评论${id}</p>`,
  content_html_version: 1,
  is_spoiler: false,
  status: 0,
  parent_id: parentId,
  user_id: 3,
  patch_id: 10,
  created: new Date('2026-01-01T00:00:00.000Z'),
  updated: new Date('2026-01-01T00:00:00.000Z'),
  user: { id: 3, name: '用户3', avatar: '' },
  patch: { unique_id: 'abcd1234' },
  _count: { like_by: likes }
})

const likeCountSelect = {
  select: { like_by: { where: { comment: { patch_id: 10 } } } }
}

beforeEach(() => {
  vi.resetAllMocks()
  countMock.mockResolvedValue(1)
  findManyMock.mockResolvedValue([])
  queryRawMock.mockResolvedValue([])
})

// 关系 _count 会被 Prisma 编译成点赞表整表 GROUP BY (C15), 必须带 patch_id 过滤才能走索引
describe('评论点赞计数限定在本 patch 内', () => {
  it('根评论查询的 _count 带 comment.patch_id 过滤, 计数映射到 likeCount', async () => {
    findManyMock.mockResolvedValueOnce([commentRow(1, null, 5)])

    const { comments } = await getPatchComment(
      { patchId: 10, page: 1, limit: 10 },
      guest
    )

    expect(findManyMock.mock.calls[0][0].select._count).toEqual(likeCountSelect)
    expect(comments[0].likeCount).toBe(5)
  })

  it('后代评论查询的 _count 同样带 comment.patch_id 过滤, 计数映射到回复 likeCount', async () => {
    findManyMock
      .mockResolvedValueOnce([commentRow(1, null, 5)])
      .mockResolvedValueOnce([commentRow(99, 1, 3)])
    queryRawMock.mockResolvedValueOnce([{ id: 99 }])

    const { comments } = await getPatchComment(
      { patchId: 10, page: 1, limit: 10 },
      guest
    )

    expect(findManyMock).toHaveBeenCalledTimes(2)
    expect(findManyMock.mock.calls[1][0].where).toMatchObject({
      id: { in: [99] }
    })
    expect(findManyMock.mock.calls[1][0].select._count).toEqual(likeCountSelect)
    expect(comments[0].reply[0].likeCount).toBe(3)
  })
})
