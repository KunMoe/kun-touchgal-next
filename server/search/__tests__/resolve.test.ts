import { beforeEach, describe, expect, it, vi } from 'vitest'

const { tagFindManyMock, companyFindManyMock } = vi.hoisted(() => ({
  tagFindManyMock: vi.fn(),
  companyFindManyMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_tag: { findMany: tagFindManyMock },
    patch_company: { findMany: companyFindManyMock }
  }
}))

import {
  resolveCompanyIdsByNames,
  resolveTagIdsByNames
} from '~/server/search/resolve'

describe('resolveTagIdsByNames', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips the query and returns an empty map for no names', async () => {
    const map = await resolveTagIdsByNames([])
    expect(map.size).toBe(0)
    expect(tagFindManyMock).not.toHaveBeenCalled()
  })

  it('groups ids by matched name and alias', async () => {
    tagFindManyMock.mockResolvedValue([
      { id: 1, name: '恋爱', alias: [] },
      { id: 2, name: 'love', alias: ['恋爱'] }
    ])

    const map = await resolveTagIdsByNames(['恋爱'])

    expect(map.get('恋爱')).toEqual([1, 2])
  })

  it('distributes one query row across the correct name buckets only', async () => {
    tagFindManyMock.mockResolvedValue([
      { id: 1, name: '恋爱', alias: [] },
      { id: 2, name: 'love', alias: ['恋爱'] }
    ])

    const map = await resolveTagIdsByNames(['恋爱', 'love'])

    expect(map.get('恋爱')).toEqual([1, 2])
    expect(map.get('love')).toEqual([2])
  })

  it('dedupes when a row matches by both name and alias', async () => {
    tagFindManyMock.mockResolvedValue([
      { id: 5, name: '日常', alias: ['日常'] }
    ])

    const map = await resolveTagIdsByNames(['日常'])

    expect(map.get('日常')).toEqual([5])
  })

  it('dedupes repeated names into a single query', async () => {
    tagFindManyMock.mockResolvedValue([{ id: 9, name: 'x', alias: [] }])

    await resolveTagIdsByNames(['x', 'x'])

    expect(tagFindManyMock).toHaveBeenCalledTimes(1)
    expect(tagFindManyMock.mock.calls[0][0].where).toEqual({
      OR: [{ name: { in: ['x'] } }, { alias: { hasSome: ['x'] } }]
    })
  })

  // 别名的规范形是小写; 存量里没规范化的别名过渡期按原串仍能命中
  it('maps a lowercase alias back to the mixed-case input that asked for it', async () => {
    tagFindManyMock.mockResolvedValue([
      { id: 3, name: '寝取られ', alias: ['ntr'] },
      { id: 4, name: 'legacy', alias: ['NTR'] }
    ])

    const map = await resolveTagIdsByNames(['NTR', 'ntr'])

    expect(tagFindManyMock.mock.calls[0][0].where).toEqual({
      OR: [
        { name: { in: ['NTR', 'ntr'] } },
        { alias: { hasSome: ['NTR', 'ntr'] } }
      ]
    })
    expect(map.get('NTR')).toEqual([3, 4])
    expect(map.get('ntr')).toEqual([3])
  })

  it('keeps the name comparison case-sensitive', async () => {
    tagFindManyMock.mockResolvedValue([{ id: 6, name: 'ADV', alias: [] }])

    const map = await resolveTagIdsByNames(['adv'])

    expect(map.get('adv')).toBeUndefined()
  })
})

describe('resolveCompanyIdsByNames', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips the query and returns an empty map for no names', async () => {
    const map = await resolveCompanyIdsByNames([])
    expect(map.size).toBe(0)
    expect(companyFindManyMock).not.toHaveBeenCalled()
  })

  it('matches name, alias and parent_brand', async () => {
    companyFindManyMock.mockResolvedValue([
      { id: 10, name: 'Key', alias: [], parent_brand: [] },
      { id: 11, name: 'VisualArts', alias: [], parent_brand: ['Key'] }
    ])

    const map = await resolveCompanyIdsByNames(['Key'])

    expect(map.get('Key')).toEqual([10, 11])
  })

  it('compares alias and parent_brand by the normalized form too', async () => {
    companyFindManyMock.mockResolvedValue([
      { id: 12, name: 'ビジュアルアーツ', alias: ['key'], parent_brand: [] },
      { id: 13, name: 'Kinetic', alias: [], parent_brand: ['key'] }
    ])

    const map = await resolveCompanyIdsByNames(['Key'])

    expect(companyFindManyMock.mock.calls[0][0].where).toEqual({
      OR: [
        { name: { in: ['Key'] } },
        { alias: { hasSome: ['Key', 'key'] } },
        { parent_brand: { hasSome: ['Key', 'key'] } }
      ]
    })
    expect(map.get('Key')).toEqual([12, 13])
  })
})
