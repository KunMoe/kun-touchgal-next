import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findManyMock,
  countMock,
  likeFindManyMock,
  markdownToHtmlMock,
  getKvMock,
  getKvsMock,
  setKvMock,
  setKvIfAbsentMock,
  delKvMock,
  acquireKvLockMock,
  releaseKvLockMock
} = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn(),
  likeFindManyMock: vi.fn(),
  markdownToHtmlMock: vi.fn(),
  getKvMock: vi.fn(),
  getKvsMock: vi.fn(),
  setKvMock: vi.fn(),
  setKvIfAbsentMock: vi.fn(),
  delKvMock: vi.fn(),
  acquireKvLockMock: vi.fn(),
  releaseKvLockMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_resource: {
      findMany: findManyMock,
      count: countMock
    },
    user_patch_resource_like_relation: {
      findMany: likeFindManyMock
    }
  }
}))

vi.mock('~/app/api/utils/render/markdownToHtml', () => ({
  markdownToHtml: markdownToHtmlMock
}))

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  getKvs: getKvsMock,
  setKv: setKvMock,
  setKvIfAbsent: setKvIfAbsentMock,
  delKv: delKvMock,
  acquireKvLock: acquireKvLockMock,
  releaseKvLock: releaseKvLockMock
}))

import { getPatchResource } from '~/app/api/patch/resource/get'

const buildRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: 'English patch',
  section: 'Patch files',
  patch: { unique_id: 'patch-123' },
  type: ['translation'],
  language: ['en'],
  note: 'Release notes',
  platform: ['windows'],
  links: [
    {
      id: 2,
      storage: 's3',
      size: '10 MB',
      code: 'download-code',
      password: 'download-password',
      hash: 'sha256',
      content: 'archive.zip',
      sort_order: 1,
      download: 5
    }
  ],
  _count: { like_by: 3 },
  status: 0,
  user_id: 7,
  patch_id: 123,
  created: new Date('2025-01-02T03:04:05.000Z'),
  user: {
    id: 7,
    name: 'Alice',
    avatar: 'alice.webp',
    role: 1,
    _count: { patch_resource: 4 }
  },
  ...overrides
})

describe('getPatchResource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getKvsMock.mockResolvedValue(['v1', 'v1'])
    getKvMock.mockResolvedValue(null)
    countMock.mockResolvedValue(0)
    likeFindManyMock.mockResolvedValue([])
    findManyMock.mockResolvedValue([buildRow()])
    markdownToHtmlMock.mockResolvedValue('<p>Release notes</p>')
    setKvMock.mockResolvedValue(undefined)
    setKvIfAbsentMock.mockResolvedValue(true)
    acquireKvLockMock.mockResolvedValue('token-1')
    releaseKvLockMock.mockResolvedValue(undefined)
  })

  it('selects only the user fields exposed by the resource response', async () => {
    const resources = await getPatchResource(
      { patchId: 123 },
      { uid: 7, role: 1 }
    )

    expect(resources[0]?.user).toStrictEqual({
      id: 7,
      name: 'Alice',
      avatar: 'alice.webp',
      patchCount: 4,
      role: 1
    })

    const userRelation = findManyMock.mock.calls[0]?.[0].include.user
    expect(userRelation).toStrictEqual({
      select: {
        id: true,
        name: true,
        avatar: true,
        role: true,
        _count: {
          select: { patch_resource: true }
        }
      }
    })
  })

  it('queries the public view (status 0, no per-viewer like) and caches it', async () => {
    await getPatchResource({ patchId: 123 }, null)

    expect(findManyMock).toHaveBeenCalledTimes(1)
    const args = findManyMock.mock.calls[0]?.[0]
    expect(args.where).toEqual({ patch_id: 123, status: 0 })
    expect(args.include.like_by).toBeUndefined()
    expect(setKvMock).toHaveBeenCalledTimes(1)
  })

  // C25: 列表卡片不展示备注, noteHtml 只由详情页渲染; note 原文勿删, 编辑弹窗靠它预填
  it('omits noteHtml and skips markdown rendering on both list paths but keeps note', async () => {
    const shared = await getPatchResource({ patchId: 123 }, null)
    findManyMock.mockResolvedValue([buildRow({ like_by: [] })])
    const bypass = await getPatchResource({ patchId: 123 }, { uid: 9, role: 5 })

    for (const resources of [shared, bypass]) {
      expect(resources[0]).not.toHaveProperty('noteHtml')
      expect(resources[0]?.note).toBe('Release notes')
    }
    expect(findManyMock).toHaveBeenCalledTimes(2)
    expect(markdownToHtmlMock).not.toHaveBeenCalled()
  })

  it('overlays personal like state on the shared cache for logged-in users', async () => {
    getKvMock.mockResolvedValue(
      JSON.stringify([{ id: 1, isLike: false, likeCount: 3 }])
    )
    likeFindManyMock.mockResolvedValue([{ resource_id: 1 }])

    const resources = await getPatchResource(
      { patchId: 123 },
      { uid: 7, role: 1 }
    )

    expect(resources[0]?.isLike).toBe(true)
    expect(likeFindManyMock).toHaveBeenCalledWith({
      where: { user_id: 7, resource_id: { in: [1] } },
      select: { resource_id: true }
    })
    expect(findManyMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
  })

  it('does not overlay like state or query relations for anonymous viewers', async () => {
    getKvMock.mockResolvedValue(
      JSON.stringify([{ id: 1, isLike: false, likeCount: 3 }])
    )

    const resources = await getPatchResource({ patchId: 123 }, null)

    expect(resources[0]?.isLike).toBe(false)
    expect(likeFindManyMock).not.toHaveBeenCalled()
  })

  it('bypasses the shared cache and queries the per-viewer view for admins', async () => {
    findManyMock.mockResolvedValue([
      buildRow({ like_by: [{ user_id: 9, resource_id: 1 }] })
    ])

    const resources = await getPatchResource(
      { patchId: 123 },
      { uid: 9, role: 5 }
    )

    expect(resources[0]?.isLike).toBe(true)
    expect(getKvsMock).not.toHaveBeenCalled()
    expect(getKvMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()

    const args = findManyMock.mock.calls[0]?.[0]
    expect(args.where).toEqual({
      patch_id: 123,
      status: { in: [0, 2, 3] }
    })
    expect(args.include.like_by).toEqual({ where: { user_id: 9 } })
  })

  // C15: patch_id 过滤对返回行恒真, 看似冗余但勿删——无外层条件时 Prisma 7 把
  // _count 编译成点赞表整表 GROUP BY; 列表按发布时间新到旧, id 兜底 created 并列
  const LIST_COUNT = {
    select: { like_by: { where: { resource: { patch_id: 123 } } } }
  }
  const LIST_ORDER_BY = [{ created: 'desc' }, { id: 'desc' }]

  it('pushes the like count down to this patch and orders newest first on a shared cache miss', async () => {
    const resources = await getPatchResource({ patchId: 123 }, null)

    expect(findManyMock).toHaveBeenCalledTimes(1)
    const args = findManyMock.mock.calls[0]?.[0]
    expect(args.include._count).toStrictEqual(LIST_COUNT)
    expect(args.orderBy).toStrictEqual(LIST_ORDER_BY)
    expect(resources[0]?.likeCount).toBe(3)
  })

  it('pushes the like count down to this patch and orders newest first when bypassing the cache', async () => {
    findManyMock.mockResolvedValue([buildRow({ like_by: [] })])

    const resources = await getPatchResource(
      { patchId: 123 },
      { uid: 9, role: 5 }
    )

    expect(getKvMock).not.toHaveBeenCalled()
    expect(findManyMock).toHaveBeenCalledTimes(1)
    const args = findManyMock.mock.calls[0]?.[0]
    expect(args.include._count).toStrictEqual(LIST_COUNT)
    expect(args.orderBy).toStrictEqual(LIST_ORDER_BY)
    expect(resources[0]?.likeCount).toBe(3)
  })
})
