import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findFirstMock,
  findUniqueMock,
  updateMock,
  relationFindManyMock,
  transactionMock,
  invalidateMock,
  enqueueBatchMock,
  kickDrainMock,
  patchContentMock,
  tx
} = vi.hoisted(() => {
  const updateMock = vi.fn()
  const relationFindManyMock = vi.fn()
  return {
    findFirstMock: vi.fn(),
    findUniqueMock: vi.fn(),
    updateMock,
    relationFindManyMock,
    transactionMock: vi.fn(),
    invalidateMock: vi.fn(),
    enqueueBatchMock: vi.fn(),
    kickDrainMock: vi.fn(),
    patchContentMock: vi.fn(),
    tx: {
      patch_tag: { update: updateMock },
      patch_tag_relation: { findMany: relationFindManyMock }
    }
  }
})

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_tag: {
      findFirst: findFirstMock,
      findUnique: findUniqueMock
    },
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

import { Prisma } from '~/prisma/generated/prisma/client'
import { updateTag } from '~/app/api/tag/update'

const INPUT = { tagId: 1, name: 'ADV', introduction: '', alias: ['AVG'] }
const TAG = { id: 1, name: 'ADV', count: 0, alias: ['AVG'] }

describe('updateTag 搜索索引同步', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    findFirstMock.mockResolvedValue(null)
    findUniqueMock.mockResolvedValue({ name: 'AVG-old' })
    updateMock.mockResolvedValue(TAG)
    relationFindManyMock.mockResolvedValue([{ patch_id: 11 }, { patch_id: 12 }])
    transactionMock.mockImplementation(async (fn) => fn(tx))
    invalidateMock.mockResolvedValue(undefined)
    enqueueBatchMock.mockResolvedValue(undefined)
  })

  it('改名时在事务内为全部关联 patch 入队，提交后 kick', async () => {
    await expect(updateTag(INPUT)).resolves.toEqual(TAG)

    expect(relationFindManyMock).toHaveBeenCalledWith({
      where: { tag_id: 1 },
      select: { patch_id: true }
    })
    // 入队作用在事务 tx 上，与标签变更原子提交
    expect(enqueueBatchMock).toHaveBeenCalledWith(tx, [11, 12])
    expect(kickDrainMock).toHaveBeenCalledTimes(1)
    expect(invalidateMock).toHaveBeenCalledTimes(1)
    expect(patchContentMock.mock.calls).toEqual([[[11, 12]]])
  })

  it('仅改简介/别名（name 未变）不查关系、入队空数组、不 kick', async () => {
    findUniqueMock.mockResolvedValue({ name: 'ADV' })

    await expect(updateTag(INPUT)).resolves.toEqual(TAG)

    expect(relationFindManyMock).not.toHaveBeenCalled()
    expect(enqueueBatchMock).toHaveBeenCalledWith(tx, [])
    expect(kickDrainMock).not.toHaveBeenCalled()
    // 别名在简介里没有界面消费方, 不扇出到关联补丁 (KUN_TTL_TOLERATED)
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('重名冲突时返回错误、不更新、不入队', async () => {
    findFirstMock.mockResolvedValue({ ...TAG, id: 2 })

    await expect(updateTag(INPUT)).resolves.toBe('这个标签已经存在了')

    expect(updateMock).not.toHaveBeenCalled()
    expect(enqueueBatchMock).not.toHaveBeenCalled()
    expect(kickDrainMock).not.toHaveBeenCalled()
  })

  it('新加的别名撞上别人的名字时拒绝, 查重排除自己', async () => {
    findUniqueMock.mockResolvedValue({ name: 'ADV', alias: [] })
    findFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 2, name: 'avg', alias: [] })

    await expect(updateTag({ ...INPUT, alias: ['avg'] })).resolves.toBe(
      '别名「avg」已是标签「avg」的名字或别名'
    )

    expect(findFirstMock.mock.calls[1][0].where).toEqual({
      id: { not: 1 },
      OR: [{ name: { in: ['avg'] } }, { alias: { hasSome: ['avg'] } }]
    })
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('并发改名撞上 name 唯一索引时返回重名消息, 不失效缓存', async () => {
    updateMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test'
      })
    )

    await expect(updateTag(INPUT)).resolves.toBe('这个标签已经存在了')
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  // 存量别名早已撞上别人时只改简介也要能存: 只查这次新加的别名
  it('库里已有的别名不参与查重, 大小写不同也算已有', async () => {
    findUniqueMock.mockResolvedValue({ name: 'ADV', alias: ['AVG'] })

    await expect(updateTag({ ...INPUT, alias: ['avg'] })).resolves.toEqual(TAG)

    expect(findFirstMock).toHaveBeenCalledTimes(1)
  })
})
