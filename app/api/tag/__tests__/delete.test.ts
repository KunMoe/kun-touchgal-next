import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUniqueMock,
  deleteMock,
  relationFindManyMock,
  transactionMock,
  invalidateMock,
  enqueueBatchMock,
  kickDrainMock,
  patchContentMock,
  tx
} = vi.hoisted(() => {
  const deleteMock = vi.fn()
  const relationFindManyMock = vi.fn()
  return {
    findUniqueMock: vi.fn(),
    deleteMock,
    relationFindManyMock,
    transactionMock: vi.fn(),
    invalidateMock: vi.fn(),
    enqueueBatchMock: vi.fn(),
    kickDrainMock: vi.fn(),
    patchContentMock: vi.fn(),
    tx: {
      patch_tag: { delete: deleteMock },
      patch_tag_relation: { findMany: relationFindManyMock }
    }
  }
})

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_tag: { findUnique: findUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/tag/cache', () => ({
  invalidateTagListCache: invalidateMock
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutboxBatch: enqueueBatchMock,
  kickSearchOutboxDrain: kickDrainMock
}))

// 关联补丁的详情与简介内嵌标签 / 会社名, 改名与删除要失效它们 (D06-01)
vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCacheByPatchId: patchContentMock
}))

import { deleteTag } from '~/app/api/tag/delete'

const TAG = { id: 1, name: 'ADV', count: 2, alias: [] }

describe('deleteTag 搜索索引同步', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    findUniqueMock.mockResolvedValue(TAG)
    deleteMock.mockResolvedValue(TAG)
    relationFindManyMock.mockResolvedValue([{ patch_id: 11 }, { patch_id: 12 }])
    transactionMock.mockImplementation(async (fn) => fn(tx))
    invalidateMock.mockResolvedValue(undefined)
    enqueueBatchMock.mockResolvedValue(undefined)
  })

  it('删除前读取关联 patch（Cascade 会清关系行），入队后 kick', async () => {
    const events: string[] = []
    relationFindManyMock.mockImplementation(async () => {
      events.push('relation-read')
      return [{ patch_id: 11 }, { patch_id: 12 }]
    })
    deleteMock.mockImplementation(async () => {
      events.push('tag-delete')
      return TAG
    })

    await expect(deleteTag(1)).resolves.toEqual({})

    expect(events).toEqual(['relation-read', 'tag-delete'])
    // 入队作用在事务 tx 上，与删除原子提交
    expect(enqueueBatchMock).toHaveBeenCalledWith(tx, [11, 12])
    expect(kickDrainMock).toHaveBeenCalledTimes(1)
    expect(invalidateMock).toHaveBeenCalledTimes(1)
    expect(patchContentMock.mock.calls).toEqual([[[11, 12]]])
  })

  it('无关联 patch 时入队空数组、不 kick', async () => {
    relationFindManyMock.mockResolvedValue([])

    await expect(deleteTag(1)).resolves.toEqual({})

    expect(enqueueBatchMock).toHaveBeenCalledWith(tx, [])
    expect(kickDrainMock).not.toHaveBeenCalled()
  })

  it('标签不存在时返回错误、不删除、不入队', async () => {
    findUniqueMock.mockResolvedValue(null)

    await expect(deleteTag(1)).resolves.toBe('未找到对应的标签')

    expect(deleteMock).not.toHaveBeenCalled()
    expect(enqueueBatchMock).not.toHaveBeenCalled()
    expect(patchContentMock).not.toHaveBeenCalled()
  })
})
