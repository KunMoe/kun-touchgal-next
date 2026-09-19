import { describe, expect, it } from 'vitest'
import { dropLoadedRatings } from '~/components/patch/rating/dropLoadedRatings'
import type { KunPatchRating } from '~/types/api/galgame'

const rating = (id: number, shortSummary = `r${id}`): KunPatchRating => ({
  id,
  uniqueId: 'abcdefg',
  recommend: 'yes',
  overall: 8,
  playStatus: 'finished',
  shortSummary,
  spoilerLevel: 'none',
  status: 0,
  isLike: false,
  likeCount: 0,
  userId: 1,
  patchId: 1,
  created: new Date(id * 1000).toISOString(),
  updated: new Date(id * 1000).toISOString(),
  user: { id: 1, name: 'a', avatar: '' }
})

describe('dropLoadedRatings', () => {
  it('本地前插后 offset 右移, 下一页首条已在列表时被剔除且以本地为准', () => {
    const prev = [rating(31), rating(30), rating(29)]
    const incoming = [rating(29, 'server-copy'), rating(28), rating(27)]

    expect(dropLoadedRatings(prev, incoming).map((r) => r.id)).toEqual([28, 27])
  })

  it('无重叠时全量保留并维持服务端顺序', () => {
    const prev = [rating(31), rating(30)]
    const incoming = [rating(29), rating(28), rating(27)]

    expect(dropLoadedRatings(prev, incoming)).toEqual(incoming)
  })
})
