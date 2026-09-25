import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findFirstMock, findManyMock, followFindUniqueMock } = vi.hoisted(
  () => ({
    findFirstMock: vi.fn(),
    findManyMock: vi.fn(),
    followFindUniqueMock: vi.fn()
  })
)

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_resource: { findFirst: findFirstMock, findMany: findManyMock },
    user_follow_relation: { findUnique: followFindUniqueMock }
  }
}))

vi.mock('~/app/api/utils/render/markdownToHtml', () => ({
  markdownToHtml: vi.fn(async (markdown: string) => `<p>${markdown}</p>`)
}))

import { getPatchResourceDetail } from '~/app/api/patch/resource/detail'

const created = new Date('2026-01-01T00:00:00.000Z')
const resourceRow = {
  id: 5,
  name: 'res',
  section: 'galgame',
  note: 'note',
  download: 30,
  type: ['game'],
  language: ['zh-Hans'],
  platform: ['windows'],
  status: 0,
  user_id: 3,
  patch_id: 10,
  created,
  updated: created,
  patch: {
    id: 10,
    unique_id: 'patch-10',
    name: 'Patch',
    banner: 'https://img/banner.avif',
    view: 100,
    download: 50,
    type: ['pc'],
    language: ['zh-Hans'],
    platform: ['windows'],
    created,
    favorite_count: 4,
    resource_count: 2,
    comment_count: 6,
    rating_stat: { avg_overall: 8.55 },
    content_limit: 'sfw'
  },
  user: {
    id: 3,
    name: 'uploader',
    avatar: '',
    role: 1,
    _count: { patch_resource: 2 }
  },
  links: [],
  _count: { like_by: 1 },
  like_by: []
}

beforeEach(() => {
  vi.clearAllMocks()
  findFirstMock.mockResolvedValue(resourceRow)
  findManyMock.mockResolvedValue([])
  followFindUniqueMock.mockResolvedValue(null)
})

describe('getPatchResourceDetail', () => {
  it('游客视角只可见 status=0 的资源', async () => {
    await getPatchResourceDetail(5, null)

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5, status: 0 }
      })
    )
  })

  it('登录用户可见公开资源与自己的待审核资源', async () => {
    await getPatchResourceDetail(5, { uid: 3, role: 1 })

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 5,
          OR: [{ status: 0 }, { status: { in: [2, 3] }, user_id: 3 }]
        }
      })
    )
  })

  // C15: 列表查询的 _count 带 patch_id 冗余过滤以免整表 GROUP BY; 详情按 id
  // findFirst 本身即可下推, 保持无过滤形式, 勿与列表「统一」
  it('详情查询的点赞计数保持无过滤的 _count', async () => {
    await getPatchResourceDetail(5, null)

    expect(findFirstMock.mock.calls[0]?.[0].include._count).toStrictEqual({
      select: { like_by: true }
    })
  })

  it('返回资源映射与所属游戏信息', async () => {
    const result = await getPatchResourceDetail(5, null)

    expect(result).toEqual(
      expect.objectContaining({
        patchName: 'Patch',
        contentLimit: 'sfw',
        resource: expect.objectContaining({
          id: 5,
          uniqueId: 'patch-10',
          noteHtml: '<p>note</p>',
          download: 30,
          likeCount: 1,
          isLike: false
        }),
        galgame: expect.objectContaining({
          id: 10,
          uniqueId: 'patch-10',
          banner: 'https://img/banner.avif',
          averageRating: 8.6,
          _count: { favorite_folder: 4, resource: 2, comment: 6 }
        })
      })
    )
  })

  it('viewer 已点赞时 isLike 为 true', async () => {
    findFirstMock.mockResolvedValue({
      ...resourceRow,
      like_by: [{ user_id: 7 }]
    })

    const result = await getPatchResourceDetail(5, { uid: 7, role: 1 })

    expect(typeof result).not.toBe('string')
    if (typeof result !== 'string') {
      expect(result.resource.isLike).toBe(true)
    }
  })

  it('其他资源按同 patch 同 section 过滤且排除自身, 可见性口径与本资源一致', async () => {
    await getPatchResourceDetail(5, null)

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          patch_id: 10,
          section: 'galgame',
          id: { not: 5 },
          status: 0
        },
        orderBy: { created: 'desc' },
        take: 12
      })
    )
  })

  it('返回映射后的其他资源列表', async () => {
    findManyMock.mockResolvedValue([
      {
        id: 6,
        name: 'other',
        section: 'galgame',
        created,
        user: { name: 'uploader', avatar: '' }
      }
    ])

    const result = await getPatchResourceDetail(5, null)

    expect(typeof result).not.toBe('string')
    if (typeof result !== 'string') {
      expect(result.otherResources).toEqual([
        {
          id: 6,
          name: 'other',
          section: 'galgame',
          created: String(created),
          user: { name: 'uploader', avatar: '' }
        }
      ])
    }
  })

  it('viewer 已关注上传者时 isFollowingUploader 为 true, 仅对非本人查询关注关系', async () => {
    followFindUniqueMock.mockResolvedValue({ id: 99 })

    const result = await getPatchResourceDetail(5, { uid: 7, role: 1 })

    expect(followFindUniqueMock).toHaveBeenCalledWith({
      where: {
        follower_id_following_id: { follower_id: 7, following_id: 3 }
      },
      select: { id: true }
    })
    expect(typeof result).not.toBe('string')
    if (typeof result !== 'string') {
      expect(result.isFollowingUploader).toBe(true)
    }
  })

  it('游客与上传者本人不查询关注关系', async () => {
    const guest = await getPatchResourceDetail(5, null)
    const self = await getPatchResourceDetail(5, { uid: 3, role: 1 })

    expect(followFindUniqueMock).not.toHaveBeenCalled()
    for (const result of [guest, self]) {
      expect(typeof result).not.toBe('string')
      if (typeof result !== 'string') {
        expect(result.isFollowingUploader).toBe(false)
      }
    }
  })

  it('资源不存在或不可见时返回错误字符串', async () => {
    findFirstMock.mockResolvedValue(null)

    const result = await getPatchResourceDetail(5, null)

    expect(result).toBe('未找到该资源')
  })
})
