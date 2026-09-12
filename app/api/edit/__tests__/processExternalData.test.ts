import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleBatchPatchTagsMock,
  tagFindManyMock,
  tagCreateManyMock,
  tagRelationFindManyMock,
  tagRelationCreateManyMock,
  companyFindManyMock,
  companyCreateManyMock,
  companyRelationCreateManyMock,
  aliasFindManyMock,
  aliasCreateManyMock,
  invalidateTagCacheMock,
  invalidateCompanyCacheMock
} = vi.hoisted(() => ({
  handleBatchPatchTagsMock: vi.fn(),
  tagFindManyMock: vi.fn(),
  tagCreateManyMock: vi.fn(),
  tagRelationFindManyMock: vi.fn(),
  tagRelationCreateManyMock: vi.fn(),
  companyFindManyMock: vi.fn(),
  companyCreateManyMock: vi.fn(),
  companyRelationCreateManyMock: vi.fn(),
  aliasFindManyMock: vi.fn(),
  aliasCreateManyMock: vi.fn(),
  invalidateTagCacheMock: vi.fn(),
  invalidateCompanyCacheMock: vi.fn()
}))

vi.mock('~/app/api/edit/batchTag', () => ({
  handleBatchPatchTags: handleBatchPatchTagsMock
}))

vi.mock('~/app/api/tag/cache', () => ({
  invalidateTagListCache: invalidateTagCacheMock
}))

vi.mock('~/app/api/company/cache', () => ({
  invalidateCompanyListCache: invalidateCompanyCacheMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_tag: {
      findMany: tagFindManyMock,
      createMany: tagCreateManyMock
    },
    patch_tag_relation: {
      findMany: tagRelationFindManyMock,
      createMany: tagRelationCreateManyMock
    },
    patch_company: {
      findMany: companyFindManyMock,
      createMany: companyCreateManyMock
    },
    patch_company_relation: {
      createMany: companyRelationCreateManyMock
    },
    patch_alias: {
      findMany: aliasFindManyMock,
      createMany: aliasCreateManyMock
    }
  }
}))

import { processSubmittedExternalData } from '~/app/api/edit/processExternalData'

const EMPTY_DATA = {
  vndbTags: [],
  vndbDevelopers: [],
  bangumiTags: [],
  bangumiDevelopers: [],
  steamTags: [],
  steamDevelopers: [],
  steamAliases: [],
  dlsiteCircleName: '',
  dlsiteCircleLink: ''
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  // rejected 任务会真打日志, 静音以免注入失败的用例刷屏, 断言对 errorSpy 做 (expect(console.x) 会触 no-console)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  handleBatchPatchTagsMock.mockResolvedValue({
    success: true,
    changed: false
  })
  tagFindManyMock.mockResolvedValue([])
  tagCreateManyMock.mockResolvedValue({ count: 1 })
  tagRelationFindManyMock.mockResolvedValue([])
  tagRelationCreateManyMock.mockResolvedValue({ count: 1 })
  companyFindManyMock.mockResolvedValue([])
  companyCreateManyMock.mockResolvedValue({ count: 1 })
  companyRelationCreateManyMock.mockResolvedValue({ count: 1 })
  aliasFindManyMock.mockResolvedValue([])
  aliasCreateManyMock.mockResolvedValue({ count: 1 })
  invalidateTagCacheMock.mockResolvedValue(undefined)
  invalidateCompanyCacheMock.mockResolvedValue(undefined)
})

describe('processSubmittedExternalData cache invalidation', () => {
  it('keeps valid caches when both tasks fail before their first write', async () => {
    const tagError = new Error('tag read failed')
    const companyError = new Error('company read failed')
    tagFindManyMock.mockRejectedValueOnce(tagError)
    companyFindManyMock.mockRejectedValueOnce(companyError)

    await processSubmittedExternalData(
      1,
      {
        ...EMPTY_DATA,
        vndbTags: ['ADV'],
        vndbDevelopers: ['Key']
      },
      [],
      7
    )

    expect(tagCreateManyMock).not.toHaveBeenCalled()
    expect(companyCreateManyMock).not.toHaveBeenCalled()
    expect(invalidateTagCacheMock).not.toHaveBeenCalled()
    expect(invalidateCompanyCacheMock).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to process external tag data for patch 1:',
      tagError
    )
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to process external company data for patch 1:',
      companyError
    )
  })

  it('invalidates tags when a later step fails after tag creation', async () => {
    tagFindManyMock
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('tag reread failed'))

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['ADV'] },
      [],
      7
    )

    expect(tagCreateManyMock).toHaveBeenCalledTimes(1)
    expect(invalidateTagCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateCompanyCacheMock).not.toHaveBeenCalled()
  })

  it('invalidates companies when a later step fails after company creation', async () => {
    companyFindManyMock
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('company reread failed'))

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbDevelopers: ['Key'] },
      [],
      7
    )

    expect(companyCreateManyMock).toHaveBeenCalledTimes(1)
    expect(invalidateCompanyCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateTagCacheMock).not.toHaveBeenCalled()
  })

  it('coalesces all company sources into one task and one invalidation', async () => {
    await processSubmittedExternalData(
      1,
      {
        ...EMPTY_DATA,
        vndbDevelopers: ['Key'],
        bangumiDevelopers: ['AliceSoft'],
        steamDevelopers: ['Navel']
      },
      [],
      7
    )

    expect(companyCreateManyMock).toHaveBeenCalledTimes(1)
    expect(companyCreateManyMock.mock.calls[0][0].data).toHaveLength(3)
    expect(invalidateCompanyCacheMock).toHaveBeenCalledTimes(1)
  })
})

describe('processSubmittedExternalData company dedup', () => {
  it('creates a same-named company from multiple sources only once', async () => {
    await processSubmittedExternalData(
      1,
      {
        ...EMPTY_DATA,
        vndbDevelopers: ['Key'],
        bangumiDevelopers: ['Key'],
        steamDevelopers: [' Key '],
        dlsiteCircleName: 'Key',
        dlsiteCircleLink: 'https://key.example.com'
      },
      [],
      7
    )

    expect(companyCreateManyMock).toHaveBeenCalledTimes(1)
    const createArgs = companyCreateManyMock.mock.calls[0][0]
    expect(createArgs.data).toHaveLength(1)
    expect(createArgs.data[0].name).toBe('Key')
    expect(createArgs.data[0].official_website).toEqual([
      'https://key.example.com'
    ])
    expect(createArgs.skipDuplicates).toBe(true)
  })

  it('drops names exceeding the 107-char column limit instead of failing the batch', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbDevelopers: ['x'.repeat(108), 'Key'] },
      [],
      7
    )

    expect(companyCreateManyMock).toHaveBeenCalledTimes(1)
    const createArgs = companyCreateManyMock.mock.calls[0][0]
    expect(createArgs.data).toHaveLength(1)
    expect(createArgs.data[0].name).toBe('Key')
  })

  it('marks company changed only for relations actually inserted', async () => {
    companyFindManyMock
      .mockResolvedValueOnce([{ name: 'Key' }])
      .mockResolvedValueOnce([{ id: 5 }])
    companyRelationCreateManyMock.mockResolvedValueOnce({ count: 1 })

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbDevelopers: ['Key'] },
      [],
      7
    )

    expect(companyCreateManyMock).not.toHaveBeenCalled()
    expect(invalidateCompanyCacheMock).toHaveBeenCalledTimes(1)
  })

  it('skips invalidation when nothing changed', async () => {
    companyFindManyMock
      .mockResolvedValueOnce([{ name: 'Key' }])
      .mockResolvedValueOnce([{ id: 5 }])
    companyRelationCreateManyMock.mockResolvedValueOnce({ count: 0 })

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbDevelopers: ['Key'] },
      [],
      7
    )

    expect(companyCreateManyMock).not.toHaveBeenCalled()
    expect(invalidateCompanyCacheMock).not.toHaveBeenCalled()
  })
})

describe('processSubmittedExternalData tag length guard', () => {
  it('drops tags exceeding the 107-char column limit instead of failing the batch', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['x'.repeat(108), 'ADV'] },
      [],
      7
    )

    expect(tagCreateManyMock).toHaveBeenCalledTimes(1)
    const createArgs = tagCreateManyMock.mock.calls[0][0]
    expect(createArgs.data).toHaveLength(1)
    expect(createArgs.data[0].name).toBe('ADV')
  })

  it('skips the tag batch entirely when all names exceed the limit', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, bangumiTags: ['x'.repeat(108)] },
      [],
      7
    )

    expect(tagFindManyMock).not.toHaveBeenCalled()
    expect(tagCreateManyMock).not.toHaveBeenCalled()
  })
})

describe('processSubmittedExternalData rejected task logging', () => {
  it('logs the failed task under its own label and keeps the other tasks running', async () => {
    const error = new Error('company read failed')
    companyFindManyMock.mockRejectedValueOnce(error)

    await processSubmittedExternalData(
      1,
      {
        ...EMPTY_DATA,
        vndbTags: ['ADV'],
        vndbDevelopers: ['Key'],
        steamAliases: ['Alias']
      },
      [],
      7
    )

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to process external company data for patch 1:',
      error
    )
    expect(tagCreateManyMock).toHaveBeenCalledTimes(1)
    expect(aliasCreateManyMock).toHaveBeenCalledTimes(1)
    expect(invalidateTagCacheMock).toHaveBeenCalledTimes(1)
  })

  it('logs alias failures under the alias label', async () => {
    const error = new Error('alias read failed')
    aliasFindManyMock.mockRejectedValueOnce(error)

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, steamAliases: ['Alias'] },
      [],
      7
    )

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to process external alias data for patch 1:',
      error
    )
  })

  it('stays silent when every task settles, including skipped ones', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['ADV'] },
      [],
      7
    )

    expect(errorSpy).not.toHaveBeenCalled()
  })
})
