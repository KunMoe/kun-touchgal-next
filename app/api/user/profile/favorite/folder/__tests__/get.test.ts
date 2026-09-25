import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, countMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user_patch_favorite_folder: {
      findMany: findManyMock,
      count: countMock
    }
  }
}))

import { getFolders } from '~/app/api/user/profile/favorite/folder/get'

const folderRow = (id: number, patchCount: number, added: boolean) => ({
  id,
  name: `收藏夹${id}`,
  description: '',
  is_public: true,
  user_id: 42,
  patch: added ? [{ id: 100 + id, folder_id: id, patch_id: 7 }] : [],
  _count: { patch: patchCount }
})

beforeEach(() => {
  vi.resetAllMocks()
  findManyMock.mockResolvedValue([])
  countMock.mockResolvedValue(0)
})

// 关系 _count 会被 Prisma 编译成子表整表 GROUP BY (C16), 必须带 user_id 过滤才能走索引
describe('收藏夹计数限定在页面用户的收藏夹内', () => {
  it('_count 带 folder.user_id 过滤', async () => {
    await getFolders({}, 42, 42)

    expect(findManyMock.mock.calls[0][0].include._count).toEqual({
      select: { patch: { where: { folder: { user_id: 42 } } } }
    })
  })

  it('他人视角同样按页面用户过滤', async () => {
    await getFolders({}, 42, 9)

    expect(findManyMock.mock.calls[0][0].include._count).toEqual({
      select: { patch: { where: { folder: { user_id: 42 } } } }
    })
  })
})

describe('getFolders', () => {
  it('没有收藏夹时返回空列表', async () => {
    await expect(getFolders({}, 42, 42)).resolves.toEqual({
      folders: [],
      total: 0
    })
  })

  it('映射 isAdd 与计数, 空收藏夹计数为 0', async () => {
    findManyMock.mockResolvedValue([
      folderRow(1, 5, true),
      folderRow(2, 0, false)
    ])

    const { folders } = await getFolders({ patchId: 7 }, 42, 42)

    expect(findManyMock.mock.calls[0][0].include.patch).toEqual({
      where: { patch_id: 7 }
    })
    expect(folders).toEqual([
      {
        id: 1,
        name: '收藏夹1',
        description: '',
        is_public: true,
        isAdd: true,
        _count: { patch: 5 }
      },
      {
        id: 2,
        name: '收藏夹2',
        description: '',
        is_public: true,
        isAdd: false,
        _count: { patch: 0 }
      }
    ])
  })

  it('本人视角不过滤 is_public, 他人视角只看公开收藏夹', async () => {
    await getFolders({}, 42, 42)
    await getFolders({}, 42, 9)

    expect(findManyMock.mock.calls[0][0].where).toEqual({
      user_id: 42,
      is_public: undefined
    })
    expect(findManyMock.mock.calls[1][0].where).toEqual({
      user_id: 42,
      is_public: true
    })
  })

  it('分页时带 skip/take 并返回总数', async () => {
    countMock.mockResolvedValue(12)

    const { total } = await getFolders(
      { patchId: 7, page: 3, limit: 5 },
      42,
      42
    )

    expect(findManyMock.mock.calls[0][0]).toMatchObject({ skip: 10, take: 5 })
    expect(countMock).toHaveBeenCalledWith({
      where: { user_id: 42, is_public: undefined }
    })
    expect(total).toBe(12)
  })

  it('不分页时不查总数', async () => {
    const { total } = await getFolders({}, 42, 42)

    expect(findManyMock.mock.calls[0][0]).toMatchObject({
      skip: undefined,
      take: undefined
    })
    expect(countMock).not.toHaveBeenCalled()
    expect(total).toBe(0)
  })
})
