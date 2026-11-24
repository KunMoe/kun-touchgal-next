import { beforeEach, describe, expect, it, vi } from 'vitest'

const { patchFindUniqueMock, invalidateContentMock, queueSearchSyncMock } =
  vi.hoisted(() => ({
    patchFindUniqueMock: vi.fn(),
    invalidateContentMock: vi.fn(),
    queueSearchSyncMock: vi.fn()
  }))

vi.mock('~/prisma', () => ({
  prisma: { patch: { findUnique: patchFindUniqueMock } }
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentMock
}))

vi.mock('~/server/search/sync', () => ({
  queueSearchSync: queueSearchSyncMock
}))

import { patchRelationHandler } from '~/app/api/patch/introduction/_relationRoute'

const invalidateListCache = vi.fn(async () => {})
const ITEMS = [
  { id: 7, name: '纯爱', count: 12, alias: [] },
  { id: 8, name: '校园', count: 30, alias: ['school'] }
]
const readItems = vi.fn(async (_patchId: number) => ITEMS)

beforeEach(() => {
  vi.resetAllMocks()
  patchFindUniqueMock.mockResolvedValue({ unique_id: 'patch-10' })
  readItems.mockResolvedValue(ITEMS)
})

describe('patchRelationHandler', () => {
  it('变更事务以业务错误结束时原样返回, 不失效缓存、不同步搜索', async () => {
    const handler = patchRelationHandler({
      mutate: async () => '标签不存在',
      invalidateListCache,
      readItems
    })

    await expect(handler({ input: { patchId: 10 } })).resolves.toBe(
      '标签不存在'
    )
    expect(invalidateListCache).not.toHaveBeenCalled()
    expect(invalidateContentMock).not.toHaveBeenCalled()
    expect(queueSearchSyncMock).not.toHaveBeenCalled()
    expect(readItems).not.toHaveBeenCalled()
  })

  it('补丁不存在时不进变更、不回读', async () => {
    patchFindUniqueMock.mockResolvedValue(null)
    const mutate = vi.fn(async () => true)
    const handler = patchRelationHandler({
      mutate,
      invalidateListCache,
      readItems
    })

    await expect(handler({ input: { patchId: 10 } })).resolves.toBe(
      '未找到 Galgame'
    )
    expect(mutate).not.toHaveBeenCalled()
    expect(readItems).not.toHaveBeenCalled()
  })

  it('关系确有变化时失效两份缓存并同步搜索', async () => {
    const handler = patchRelationHandler({
      mutate: async () => true,
      invalidateListCache,
      readItems
    })

    await expect(handler({ input: { patchId: 10 } })).resolves.toEqual({
      items: ITEMS
    })
    expect(invalidateListCache).toHaveBeenCalledTimes(1)
    expect(invalidateContentMock).toHaveBeenCalledWith('patch-10')
    expect(queueSearchSyncMock).toHaveBeenCalledWith(10)
  })

  it('回读排在失效之后: 回传的列表与刚失效的缓存出自同一时刻之后', async () => {
    const order: string[] = []
    invalidateListCache.mockImplementation(async () => {
      order.push('invalidate')
    })
    readItems.mockImplementation(async () => {
      order.push('read')
      return ITEMS
    })
    const handler = patchRelationHandler({
      mutate: async () => true,
      invalidateListCache,
      readItems
    })

    await handler({ input: { patchId: 10 } })
    expect(order).toEqual(['invalidate', 'read'])
    expect(readItems).toHaveBeenCalledWith(10)
  })

  it('关系没有变化也回传完整列表, 但一处缓存都不动', async () => {
    const handler = patchRelationHandler({
      mutate: async () => false,
      invalidateListCache,
      readItems
    })

    await expect(handler({ input: { patchId: 10 } })).resolves.toEqual({
      items: ITEMS
    })
    expect(readItems).toHaveBeenCalledWith(10)
    expect(invalidateListCache).not.toHaveBeenCalled()
    expect(invalidateContentMock).not.toHaveBeenCalled()
    expect(queueSearchSyncMock).not.toHaveBeenCalled()
  })
})
