import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findManyMock, delKvsMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  delKvsMock: vi.fn(async () => undefined)
}))

vi.mock('~/lib/redis', () => ({
  delKv: vi.fn(),
  delKvs: delKvsMock,
  getKv: vi.fn(),
  getKvs: vi.fn(),
  setKv: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findMany: findManyMock }
  }
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import {
  getPatchCacheKey,
  getPatchIntroductionCacheKey,
  invalidatePatchContentCache,
  invalidatePatchContentCacheByPatchId
} from '~/app/api/patch/cache'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('invalidatePatchContentCache', () => {
  it('两键合并为单条 DEL, 不拆成多次删除', async () => {
    await invalidatePatchContentCache('aaaaaaaa')

    expect(delKvsMock).toHaveBeenCalledTimes(1)
    expect(delKvsMock).toHaveBeenCalledWith([
      getPatchCacheKey('aaaaaaaa'),
      getPatchIntroductionCacheKey('aaaaaaaa')
    ])
  })

  it('删除失败时记录日志并向上抛出, 由调用方 best-effort 吞掉', async () => {
    const error = new Error('redis down')
    delKvsMock.mockRejectedValueOnce(error)

    await expect(invalidatePatchContentCache('aaaaaaaa')).rejects.toThrow(
      'redis down'
    )
    expect(kunLog).toHaveBeenCalledWith(
      'cache.invalidate_failed',
      {
        ns: 'patch:content',
        op: 'del',
        key: [
          getPatchCacheKey('aaaaaaaa'),
          getPatchIntroductionCacheKey('aaaaaaaa')
        ].join(',')
      },
      error
    )
  })
})

describe('invalidatePatchContentCacheByPatchId', () => {
  it('按 patch_id 解析 unique_id 并失效详情缓存两键', async () => {
    findManyMock.mockResolvedValue([{ unique_id: 'aaaaaaaa' }])

    await invalidatePatchContentCacheByPatchId(7)

    expect(findManyMock).toHaveBeenCalledWith({
      where: { id: { in: [7] } },
      select: { unique_id: true }
    })
    expect(delKvsMock).toHaveBeenCalledWith([
      getPatchCacheKey('aaaaaaaa'),
      getPatchIntroductionCacheKey('aaaaaaaa')
    ])
  })

  it('批量入参先去重再查询, 命中的每个 patch 都在同一条 DEL 内失效', async () => {
    findManyMock.mockResolvedValue([
      { unique_id: 'aaaaaaaa' },
      { unique_id: 'bbbbbbbb' }
    ])

    await invalidatePatchContentCacheByPatchId([10, 10, 20])

    expect(findManyMock).toHaveBeenCalledWith({
      where: { id: { in: [10, 20] } },
      select: { unique_id: true }
    })
    expect(delKvsMock).toHaveBeenCalledTimes(1)
    expect(delKvsMock).toHaveBeenCalledWith([
      getPatchCacheKey('aaaaaaaa'),
      getPatchIntroductionCacheKey('aaaaaaaa'),
      getPatchCacheKey('bbbbbbbb'),
      getPatchIntroductionCacheKey('bbbbbbbb')
    ])
  })

  it('空数组短路返回, 不查询数据库也不删缓存', async () => {
    await invalidatePatchContentCacheByPatchId([])

    expect(findManyMock).not.toHaveBeenCalled()
    expect(delKvsMock).not.toHaveBeenCalled()
  })
})
