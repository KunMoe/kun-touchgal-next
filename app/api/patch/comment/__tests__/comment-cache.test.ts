import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kvStore,
  lockStore,
  getKvMock,
  setKvMock,
  setKvIfAbsentMock,
  delKvMock,
  acquireKvLockMock,
  releaseKvLockMock,
  countMock,
  rootFindManyMock,
  likeFindManyMock,
  queryRawMock,
  updateManyMock,
  renderMock
} = vi.hoisted(() => {
  const kvStore = new Map<string, string>()
  const lockStore = new Set<string>()

  return {
    kvStore,
    lockStore,
    getKvMock: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    setKvMock: vi.fn(async (key: string, value: string) => {
      kvStore.set(key, value)
    }),
    setKvIfAbsentMock: vi.fn(async (key: string, value: string) => {
      if (!kvStore.has(key)) {
        kvStore.set(key, value)
      }
    }),
    delKvMock: vi.fn(async (key: string) => {
      kvStore.delete(key)
    }),
    acquireKvLockMock: vi.fn(async (key: string) => {
      if (lockStore.has(key)) {
        return null
      }
      lockStore.add(key)
      return 'lock-token'
    }),
    releaseKvLockMock: vi.fn(async (key: string) => {
      lockStore.delete(key)
    }),
    countMock: vi.fn(),
    rootFindManyMock: vi.fn(),
    likeFindManyMock: vi.fn(),
    queryRawMock: vi.fn(),
    updateManyMock: vi.fn(async () => ({ count: 1 })),
    renderMock: vi.fn()
  }
})

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: setKvMock,
  setKvIfAbsent: setKvIfAbsentMock,
  delKv: delKvMock,
  acquireKvLock: acquireKvLockMock,
  releaseKvLock: releaseKvLockMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: {
      count: countMock,
      findMany: rootFindManyMock,
      updateMany: updateManyMock
    },
    user_patch_comment_like_relation: {
      findMany: likeFindManyMock
    },
    $queryRaw: queryRawMock
  }
}))

vi.mock('~/app/api/utils/render/profiles', () => ({
  KUN_MARKDOWN_PROFILES: { comment: { version: 1 } }
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdown: renderMock
}))

import { getPatchComment } from '~/app/api/patch/comment/get'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'

const rootComment = {
  id: 100,
  content: 'hello',
  content_html: '<p>hello</p>',
  content_html_version: 1,
  is_spoiler: false,
  status: 0,
  parent_id: null,
  user_id: 5,
  patch_id: 10,
  created: new Date('2026-01-01T00:00:00.000Z'),
  updated: new Date('2026-01-01T00:00:00.000Z'),
  user: { id: 5, name: 'author', avatar: '' },
  patch: { unique_id: 'patch-10' },
  _count: { like_by: 3 }
}

const input = { patchId: 10, page: 1, limit: 10 }
const viewer = { uid: 7, role: 1 }
const adminViewer = { uid: 9, role: 3 }

beforeEach(() => {
  vi.clearAllMocks()
  kvStore.clear()
  lockStore.clear()
  // where.status === 1 是 bypass 检查 (用户自己的待审评论数), 其余是根评论总数
  countMock.mockImplementation(
    async ({ where }: { where: { status?: number } }) =>
      where.status === 1 ? 0 : 1
  )
  rootFindManyMock.mockResolvedValue([rootComment])
  likeFindManyMock.mockResolvedValue([])
  queryRawMock.mockResolvedValue([])
  renderMock.mockImplementation(async (_profile: string, markdown: string) => ({
    ok: true,
    html: `<p>${markdown}</p>`,
    version: 1
  }))
})

describe('getPatchComment 缓存', () => {
  it('缓存命中时不重建评论树', async () => {
    await getPatchComment(input, viewer)
    rootFindManyMock.mockClear()

    const result = await getPatchComment(input, viewer)

    expect(rootFindManyMock).not.toHaveBeenCalled()
    expect(result.comments[0].id).toBe(100)
    expect(result.total).toBe(1)
  })

  it('命中缓存后仍按 uid 叠加 isLike, 不受基线影响', async () => {
    await getPatchComment(input, viewer)
    likeFindManyMock.mockResolvedValueOnce([{ comment_id: 100 }])

    const result = await getPatchComment(input, viewer)

    expect(rootFindManyMock).toHaveBeenCalledTimes(1)
    expect(result.comments[0].isLike).toBe(true)
  })

  it('管理员绕过共享缓存, 不读版本键, 每次重建', async () => {
    await getPatchComment(input, adminViewer)
    await getPatchComment(input, adminViewer)

    expect(getKvMock).not.toHaveBeenCalled()
    expect(rootFindManyMock).toHaveBeenCalledTimes(2)
  })

  it('有自己待审评论的用户绕过共享缓存', async () => {
    countMock.mockImplementation(
      async ({ where }: { where: { status?: number } }) =>
        where.status === 1 ? 2 : 1
    )

    await getPatchComment(input, viewer)
    await getPatchComment(input, viewer)

    expect(getKvMock).not.toHaveBeenCalled()
    expect(rootFindManyMock).toHaveBeenCalledTimes(2)
  })

  // content.viewPending 的边界: 创作者 (role 2) 与普通用户一样走共享缓存,
  // 管理员 (role 3) 起绕过共享缓存
  it.each([1, 2])(
    'role %i 没有自己的待审评论时走共享缓存, 第二次命中不重建',
    async (role) => {
      const roleViewer = { uid: 7, role }

      await getPatchComment(input, roleViewer)
      await getPatchComment(input, roleViewer)

      expect(countMock).toHaveBeenCalledWith({
        where: { patch_id: 10, user_id: 7, status: 1 }
      })
      expect(getKvMock).toHaveBeenCalled()
      expect(rootFindManyMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each([3, 4])(
    'role %i 绕过共享缓存, 不查自己的待审评论数, 每次重建',
    async (role) => {
      const roleViewer = { uid: 7, role }

      await getPatchComment(input, roleViewer)
      await getPatchComment(input, roleViewer)

      expect(countMock).not.toHaveBeenCalledWith({
        where: { patch_id: 10, user_id: 7, status: 1 }
      })
      expect(getKvMock).not.toHaveBeenCalled()
      expect(rootFindManyMock).toHaveBeenCalledTimes(2)
    }
  )

  it('失效后重新回源', async () => {
    await getPatchComment(input, viewer)
    rootFindManyMock.mockClear()

    await invalidatePatchCommentCache(10)
    const result = await getPatchComment(input, viewer)

    expect(rootFindManyMock).toHaveBeenCalledTimes(1)
    expect(result.comments[0].id).toBe(100)
  })

  it('资源评论区与游戏评论区分页缓存互不串键', async () => {
    await getPatchComment(input, viewer)
    rootFindManyMock.mockClear()

    // 同 patch 的资源评论区首次访问: 不命中游戏评论区的缓存, 且按资源维度过滤
    await getPatchComment({ ...input, resourceId: 5 }, viewer)
    expect(rootFindManyMock).toHaveBeenCalledTimes(1)
    expect(rootFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ resource_id: 5 })
      })
    )

    // 两侧各自命中缓存
    rootFindManyMock.mockClear()
    await getPatchComment(input, viewer)
    await getPatchComment({ ...input, resourceId: 5 }, viewer)
    expect(rootFindManyMock).not.toHaveBeenCalled()
  })

  it('版本失效同时覆盖游戏评论区与资源评论区', async () => {
    await getPatchComment(input, viewer)
    await getPatchComment({ ...input, resourceId: 5 }, viewer)
    rootFindManyMock.mockClear()

    await invalidatePatchCommentCache(10)

    await getPatchComment(input, viewer)
    await getPatchComment({ ...input, resourceId: 5 }, viewer)
    expect(rootFindManyMock).toHaveBeenCalledTimes(2)
  })

  it('版本过期的历史评论回落渲染并写回自愈', async () => {
    rootFindManyMock.mockResolvedValueOnce([
      { ...rootComment, content_html: '<p>old</p>', content_html_version: 0 }
    ])

    const result = await getPatchComment(input, viewer)

    // 版本不匹配 → 回落渲染入口 (mock: `<p>${content}</p>`)
    expect(result.comments[0].content).toBe('<p>hello</p>')
    // fire-and-forget 写回, flush 微任务后断言幂等前置条件 (updated 用于防止并发修改时误写旧渲染)
    await Promise.resolve()
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: 100,
        content_html_version: { not: 1 },
        updated: new Date('2026-01-01T00:00:00.000Z')
      },
      data: { content_html: '<p>hello</p>', content_html_version: 1 }
    })
  })

  // P02-01: 一条渲染不出来的评论曾让整页 reject (500), 且每次读都重付渲染成本
  it('一页里有一条渲染不出来的评论时只降级该条, 整页照常返回', async () => {
    const poison = {
      ...rootComment,
      id: 101,
      content: 'poison',
      content_html: '',
      content_html_version: 0
    }
    rootFindManyMock.mockResolvedValueOnce([rootComment, poison])
    renderMock.mockImplementation(async () => ({
      ok: false,
      reason: 'too-deep',
      html: '<p>poison</p>\n<p>已按纯文本显示</p>',
      version: 1,
      persistable: true
    }))

    const result = await getPatchComment(input, viewer)

    expect(result.comments.map((comment) => comment.id)).toEqual([100, 101])
    expect(result.comments[0].content).toBe('<p>hello</p>')
    expect(result.comments[1].content).toContain('已按纯文本显示')
    // 预算给出的降级结果是确定的, 按当前版本写回后不再重渲染
    await Promise.resolve()
    expect(updateManyMock).toHaveBeenCalledTimes(1)
    expect(updateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 101 }),
        data: {
          content_html: '<p>poison</p>\n<p>已按纯文本显示</p>',
          content_html_version: 1
        }
      })
    )
  })

  it('渲染缺陷 (render-error) 的降级结果只用于本次响应, 不写回', async () => {
    rootFindManyMock.mockResolvedValueOnce([
      { ...rootComment, content_html: '', content_html_version: 0 }
    ])
    renderMock.mockImplementation(async () => ({
      ok: false,
      reason: 'render-error',
      html: '<p>hello</p>\n<p>暂时无法渲染</p>',
      version: 1,
      persistable: false
    }))

    const result = await getPatchComment(input, viewer)

    expect(result.comments[0].content).toContain('暂时无法渲染')
    await Promise.resolve()
    expect(updateManyMock).not.toHaveBeenCalled()
  })
})
