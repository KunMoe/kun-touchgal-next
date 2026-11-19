import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  fetchVndbVnMock,
  fetchSteamAppDataMock,
  fetchDlsiteDataMock,
  fetchBangumiDeveloperNamesMock,
  companyFindManyMock,
  companyCreateManyMock,
  companyUpdateManyMock,
  companyRelationCreateManyAndReturnMock,
  saveManualTagChangeMock,
  invalidateTagCacheMock,
  invalidateCompanyCacheMock
} = vi.hoisted(() => ({
  fetchVndbVnMock: vi.fn(),
  fetchSteamAppDataMock: vi.fn(),
  fetchDlsiteDataMock: vi.fn(),
  fetchBangumiDeveloperNamesMock: vi.fn(),
  companyFindManyMock: vi.fn(),
  companyCreateManyMock: vi.fn(),
  companyUpdateManyMock: vi.fn(),
  companyRelationCreateManyAndReturnMock: vi.fn(),
  saveManualTagChangeMock: vi.fn(),
  invalidateTagCacheMock: vi.fn(),
  invalidateCompanyCacheMock: vi.fn()
}))

vi.mock('~/lib/arnebiae/vndb', () => ({
  fetchVndbVn: fetchVndbVnMock
}))

vi.mock('~/lib/arnebiae/steam', () => ({
  fetchSteamAppData: fetchSteamAppDataMock
}))

vi.mock('~/lib/arnebiae/dlsite', () => ({
  fetchDlsiteData: fetchDlsiteDataMock
}))

vi.mock('~/app/api/edit/bangumi/_developers', () => ({
  fetchBangumiDeveloperNames: fetchBangumiDeveloperNamesMock
}))

vi.mock('~/app/api/edit/batchTag', () => ({
  saveManualTagChange: saveManualTagChangeMock
}))

vi.mock('~/app/api/tag/cache', () => ({
  invalidateTagListCache: invalidateTagCacheMock
}))

vi.mock('~/app/api/company/cache', () => ({
  invalidateCompanyListCache: invalidateCompanyCacheMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_company: {
      findMany: companyFindManyMock,
      createMany: companyCreateManyMock,
      updateMany: companyUpdateManyMock
    },
    patch_company_relation: {
      createManyAndReturn: companyRelationCreateManyAndReturnMock
    }
  }
}))

import { gatherAndEnsurePatchCompanies } from '~/app/api/patch/introduction/company/_gatherCompanies'

beforeEach(() => {
  vi.clearAllMocks()
  fetchVndbVnMock.mockResolvedValue({ results: [{ developers: [] }] })
  fetchSteamAppDataMock.mockResolvedValue({ developers: [] })
  fetchDlsiteDataMock.mockResolvedValue({})
  fetchBangumiDeveloperNamesMock.mockResolvedValue([])
  companyFindManyMock.mockResolvedValue([])
  companyCreateManyMock.mockResolvedValue({ count: 1 })
  companyUpdateManyMock.mockResolvedValue({ count: 1 })
  companyRelationCreateManyAndReturnMock.mockResolvedValue([{ company_id: 1 }])
  invalidateTagCacheMock.mockResolvedValue(undefined)
  invalidateCompanyCacheMock.mockResolvedValue(undefined)
})

describe('gatherAndEnsurePatchCompanies', () => {
  it('merges four sources into a single dedup company creation with per-source websites', async () => {
    fetchVndbVnMock.mockResolvedValue({
      results: [{ developers: [{ name: 'Key', type: 'co' }] }]
    })
    fetchBangumiDeveloperNamesMock.mockResolvedValue(['Key'])
    fetchSteamAppDataMock.mockResolvedValue({
      developers: [{ name: 'Navel', link: 'https://navel.example.com' }]
    })
    fetchDlsiteDataMock.mockResolvedValue({
      circle_name: 'Key',
      circle_link: 'https://key.example.com'
    })

    const result = await gatherAndEnsurePatchCompanies(
      1,
      { vndbId: 'v1', bangumiId: 100, steamId: 200, dlsiteCode: 'RJ1' },
      7
    )

    expect(companyCreateManyMock).toHaveBeenCalledTimes(1)
    const data = companyCreateManyMock.mock.calls[0][0].data as {
      name: string
      official_website: string[]
    }[]
    expect(data).toHaveLength(2)
    const key = data.find((c) => c.name === 'Key')
    const navel = data.find((c) => c.name === 'Navel')
    expect(key?.official_website).toEqual(['https://key.example.com'])
    expect(navel?.official_website).toEqual(['https://navel.example.com'])
    expect(result.changed).toBe(true)
  })

  it('only queries sources that have an external id', async () => {
    fetchVndbVnMock.mockResolvedValue({
      results: [{ developers: [{ name: 'Key', type: 'co' }] }]
    })

    await gatherAndEnsurePatchCompanies(
      1,
      { vndbId: 'v1', bangumiId: null, steamId: null, dlsiteCode: null },
      7
    )

    expect(fetchVndbVnMock).toHaveBeenCalledTimes(1)
    expect(fetchBangumiDeveloperNamesMock).not.toHaveBeenCalled()
    expect(fetchSteamAppDataMock).not.toHaveBeenCalled()
    expect(fetchDlsiteDataMock).not.toHaveBeenCalled()
    expect(companyCreateManyMock).toHaveBeenCalledTimes(1)
  })

  it('keeps only company/circle/individual vndb developer types', async () => {
    fetchVndbVnMock.mockResolvedValue({
      results: [
        {
          developers: [
            { name: 'Key', type: 'co' },
            { name: 'NotADeveloper', type: null }
          ]
        }
      ]
    })

    await gatherAndEnsurePatchCompanies(
      1,
      { vndbId: 'v1', bangumiId: null, steamId: null, dlsiteCode: null },
      7
    )

    const data = companyCreateManyMock.mock.calls[0][0].data as {
      name: string
    }[]
    expect(data.map((c) => c.name)).toEqual(['Key'])
  })

  it('short-circuits without touching the database when no source yields a name', async () => {
    const result = await gatherAndEnsurePatchCompanies(
      1,
      { vndbId: 'v1', bangumiId: 100, steamId: 200, dlsiteCode: 'RJ1' },
      7
    )

    expect(result).toEqual({ changed: false, fetched: 0 })
    expect(companyCreateManyMock).not.toHaveBeenCalled()
  })
})
