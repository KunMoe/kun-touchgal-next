import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  folderFindUnique: vi.fn(),
  relationFindMany: vi.fn(),
  txRelationFindMany: vi.fn(),
  folderDelete: vi.fn(),
  transaction: vi.fn(),
  bumpVersion: vi.fn(),
  invalidateStatus: vi.fn(),
  invalidateContent: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user_patch_favorite_folder: { findUnique: mocks.folderFindUnique },
    user_patch_favorite_folder_relation: { findMany: mocks.relationFindMany },
    $transaction: mocks.transaction
  }
}))

vi.mock('~/app/api/patch/cache', () => ({
  bumpPatchFavoriteCacheVersion: mocks.bumpVersion,
  invalidatePatchFavoriteCaches: mocks.invalidateStatus,
  invalidatePatchContentCacheByPatchId: mocks.invalidateContent
}))

import { deleteFolder } from '~/app/api/user/profile/favorite/folder/delete'

// 事务外读的收藏关系 (带 unique_id, 用于本人的收藏状态缓存, 最多 501 条)
const relation = (patchId: number) => ({ patch: { unique_id: `u${patchId}` } })
// 事务内删除之前读的全部收藏关系 (只取 patch_id)
const removedRelations = (patchIds: number[]) =>
  patchIds.map((patchId) => ({ patch_id: patchId }))

let events: string[] = []

beforeEach(() => {
  vi.resetAllMocks()
  events = []
  mocks.folderFindUnique.mockResolvedValue({ id: 1, user_id: 7 })
  mocks.relationFindMany.mockResolvedValue([relation(5), relation(3)])
  mocks.txRelationFindMany.mockImplementation(async () => {
    events.push('read')
    return removedRelations([5, 3])
  })
  mocks.folderDelete.mockImplementation(async () => {
    events.push('delete')
  })
  mocks.transaction.mockImplementation(async (callback) => {
    const result = await callback({
      user_patch_favorite_folder: { delete: mocks.folderDelete },
      user_patch_favorite_folder_relation: {
        findMany: mocks.txRelationFindMany
      }
    })
    events.push('commit')
    return result
  })
  mocks.invalidateContent.mockImplementation(async () => {
    events.push('invalidate-content')
  })
})

describe('deleteFolder', () => {
  // 收藏关系随级联消失, 触发器递减这些补丁的收藏数, 补丁详情内嵌这个数 (D06-02)
  it('提交之后失效收藏夹里每个补丁的详情缓存与本人的收藏状态', async () => {
    await expect(deleteFolder({ folderId: 1 }, 7)).resolves.toEqual({})

    expect(mocks.folderDelete).toHaveBeenCalledWith({ where: { id: 1 } })
    expect(mocks.txRelationFindMany).toHaveBeenCalledWith({
      where: { folder_id: 1 },
      select: { patch_id: true }
    })
    expect(mocks.invalidateContent.mock.calls).toEqual([[[3, 5]]])
    // 级联会清掉收藏关系, 所以在删除之前读; 失效排在提交之后
    expect(events).toEqual(['read', 'delete', 'commit', 'invalidate-content'])
    expect(mocks.invalidateStatus).toHaveBeenCalledWith(['u5', 'u3'], 7)
    expect(mocks.bumpVersion).not.toHaveBeenCalled()
  })

  // 收藏状态缓存超过上限只换版本号; 补丁详情不受这个上限限制
  it('超过 500 条时收藏状态换版本号, 补丁详情照样逐个失效', async () => {
    const patchIds = Array.from({ length: 600 }, (_, index) => index + 1)
    mocks.relationFindMany.mockResolvedValue(
      patchIds.slice(0, 501).map((patchId) => relation(patchId))
    )
    mocks.txRelationFindMany.mockResolvedValue(removedRelations(patchIds))

    await expect(deleteFolder({ folderId: 1 }, 7)).resolves.toEqual({})

    expect(mocks.bumpVersion).toHaveBeenCalledWith(7)
    expect(mocks.invalidateStatus).not.toHaveBeenCalled()
    expect(mocks.invalidateContent.mock.calls).toEqual([[patchIds]])
  })

  it('详情失效失败不影响删除结果', async () => {
    mocks.invalidateContent.mockRejectedValue(new Error('redis down'))
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await expect(deleteFolder({ folderId: 1 }, 7)).resolves.toEqual({})

    expect(mocks.invalidateStatus).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('不是自己的收藏夹时不删除、不失效', async () => {
    mocks.folderFindUnique.mockResolvedValue({ id: 1, user_id: 8 })

    await expect(deleteFolder({ folderId: 1 }, 7)).resolves.toBe(
      '您没有权限删除该收藏夹'
    )

    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.invalidateContent).not.toHaveBeenCalled()
  })
})
