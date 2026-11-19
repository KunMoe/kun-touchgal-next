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

beforeEach(() => {
  vi.resetAllMocks()
  patchFindUniqueMock.mockResolvedValue({ unique_id: 'patch-10' })
})

describe('patchRelationHandler', () => {
  it('变更事务以业务错误结束时原样返回, 不失效缓存、不同步搜索', async () => {
    const handler = patchRelationHandler({
      mutate: async () => '标签不存在',
      invalidateListCache
    })

    await expect(handler({ input: { patchId: 10 } })).resolves.toBe(
      '标签不存在'
    )
    expect(invalidateListCache).not.toHaveBeenCalled()
    expect(invalidateContentMock).not.toHaveBeenCalled()
    expect(queueSearchSyncMock).not.toHaveBeenCalled()
  })

  it('关系确有变化时失效两份缓存并同步搜索', async () => {
    const handler = patchRelationHandler({
      mutate: async () => true,
      invalidateListCache
    })

    await expect(handler({ input: { patchId: 10 } })).resolves.toEqual({})
    expect(invalidateListCache).toHaveBeenCalledTimes(1)
    expect(invalidateContentMock).toHaveBeenCalledWith('patch-10')
    expect(queueSearchSyncMock).toHaveBeenCalledWith(10)
  })
})
