import { beforeEach, describe, expect, it, vi } from 'vitest'

const { patchFindManyMock } = vi.hoisted(() => ({
  patchFindManyMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: { patch: { findMany: patchFindManyMock } }
}))
vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import { fetchGalgameCardsByIds } from '~/server/galgame/cards'
import { GalgameCardSelectField } from '~/constants/api/select'
import { PUBLIC_VISIBILITY } from '~/server/viewer/patchVisibility'
import { cardRow } from './cardRow'

const ALL = { contentLimit: null, blockedTagIds: [] } as const

describe('fetchGalgameCardsByIds', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('ids 为空时不查库', async () => {
    expect(await fetchGalgameCardsByIds([], PUBLIC_VISIBILITY)).toEqual([])
    expect(patchFindManyMock).not.toHaveBeenCalled()
  })

  it('按 ids 的顺序返回, 与库返回的行序无关', async () => {
    patchFindManyMock.mockResolvedValue([cardRow(1), cardRow(2), cardRow(3)])

    const cards = await fetchGalgameCardsByIds([3, 1, 2], ALL)

    expect(cards.map((card) => card.id)).toEqual([3, 1, 2])
    expect(kunLog).not.toHaveBeenCalled()
  })

  it('经 toGalgameCard 映射, 只选取卡片字段', async () => {
    patchFindManyMock.mockResolvedValue([cardRow(7)])

    const [card] = await fetchGalgameCardsByIds([7], ALL)

    expect(patchFindManyMock.mock.calls[0][0].select).toBe(
      GalgameCardSelectField
    )
    expect(card).toEqual({
      id: 7,
      uniqueId: 'uid7',
      name: 'galgame 7',
      banner: 'banner-7.avif',
      view: 70,
      download: 7,
      type: ['pc'],
      language: ['zh-Hans'],
      platform: ['windows'],
      created: new Date('2026-11-21T00:00:00Z'),
      _count: { favorite_folder: 1, resource: 2, comment: 3 },
      averageRating: 8.6
    })
  })

  it('视角的可见性条件与 id 条件以 AND 合并进同一条查询', async () => {
    patchFindManyMock.mockResolvedValue([])

    await fetchGalgameCardsByIds([1, 2], {
      contentLimit: 'sfw',
      blockedTagIds: [7, 8]
    })

    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(patchFindManyMock.mock.calls[0][0].where).toEqual({
      AND: [
        { id: { in: [1, 2] } },
        {
          content_limit: 'sfw',
          NOT: { tag: { some: { tag_id: { in: [7, 8] } } } }
        }
      ]
    })
  })

  it('分级不限且无屏蔽标签的视角不加可见性条件', async () => {
    patchFindManyMock.mockResolvedValue([])

    await fetchGalgameCardsByIds([1], ALL)

    expect(patchFindManyMock.mock.calls[0][0].where).toEqual({
      AND: [{ id: { in: [1] } }, {}]
    })
  })

  it('库里查不到的 id (已删除或对此视角不可见) 被丢弃, 并记一条带 id 的告警', async () => {
    patchFindManyMock.mockResolvedValue([cardRow(4), cardRow(2)])

    const cards = await fetchGalgameCardsByIds([2, 3, 4, 5], PUBLIC_VISIBILITY)

    expect(cards.map((card) => card.id)).toEqual([2, 4])
    expect(kunLog).toHaveBeenCalledExactlyOnceWith('search.hits_dropped', {
      requested: 4,
      dropped: 2,
      ids: '3,5'
    })
  })
})
