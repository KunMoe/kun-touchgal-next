import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  saveManualTagChangeMock,
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
  invalidateCompanyCacheMock,
  enqueueSearchOutboxMock
} = vi.hoisted(() => ({
  saveManualTagChangeMock: vi.fn(),
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
  invalidateCompanyCacheMock: vi.fn(),
  enqueueSearchOutboxMock: vi.fn()
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

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueSearchOutboxMock
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

import { prisma } from '~/prisma/index'
import { processSubmittedExternalData } from '~/app/api/edit/processExternalData'

const NO_TAG_CHANGE = { removeTagIds: [], addTagNames: [] }

const EMPTY_DATA = {
  vndbTags: [],
  vndbDevelopers: [],
  bangumiTags: [],
  bangumiDevelopers: [],
  steamTags: [],
  steamDevelopers: [],
  dlsiteTags: [],
  dlsiteCircleName: '',
  dlsiteCircleLink: ''
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  // rejected 任务会真打日志, 静音以免注入失败的用例刷屏, 断言对 errorSpy 做 (expect(console.x) 会触 no-console)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  saveManualTagChangeMock.mockResolvedValue({ changed: false })
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
  enqueueSearchOutboxMock.mockResolvedValue(undefined)
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
      NO_TAG_CHANGE,
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
      NO_TAG_CHANGE,
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
      NO_TAG_CHANGE,
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
      NO_TAG_CHANGE,
      7
    )

    expect(companyCreateManyMock).toHaveBeenCalledTimes(1)
    expect(companyCreateManyMock.mock.calls[0][0].data).toHaveLength(3)
    expect(invalidateCompanyCacheMock).toHaveBeenCalledTimes(1)
  })
})

// 手动标签的差量原样交给写入函数。旧协议里空数组既表示「不动」又表示「清空」, 这里曾用
// userTags.length 短路, 清空全部标签的提交因此不生效
describe('processSubmittedExternalData manual tag change', () => {
  it('passes a remove-only change through instead of skipping it', async () => {
    const change = { removeTagIds: [11, 12], addTagNames: [] }

    await processSubmittedExternalData(1, EMPTY_DATA, change, 7)

    expect(saveManualTagChangeMock).toHaveBeenCalledTimes(1)
    expect(saveManualTagChangeMock).toHaveBeenCalledWith(1, change, 7)
  })

  it('invalidates the tag list only when the manual change took effect', async () => {
    await processSubmittedExternalData(
      1,
      EMPTY_DATA,
      { removeTagIds: [404], addTagNames: [] },
      7
    )
    expect(invalidateTagCacheMock).not.toHaveBeenCalled()

    saveManualTagChangeMock.mockResolvedValueOnce({ changed: true })
    await processSubmittedExternalData(
      1,
      EMPTY_DATA,
      { removeTagIds: [11], addTagNames: ['纯爱'] },
      7
    )
    expect(invalidateTagCacheMock).toHaveBeenCalledTimes(1)
  })

  // 用户手填的标签写不进去要让请求失败, 不能像外部来源那样只记日志
  it('lets a failed manual change reject without touching external data', async () => {
    saveManualTagChangeMock.mockRejectedValueOnce(new Error('deadlock'))

    await expect(
      processSubmittedExternalData(
        1,
        { ...EMPTY_DATA, vndbTags: ['ADV'] },
        { removeTagIds: [], addTagNames: ['纯爱'] },
        7
      )
    ).rejects.toThrow('deadlock')
    expect(tagFindManyMock).not.toHaveBeenCalled()
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
      NO_TAG_CHANGE,
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
      NO_TAG_CHANGE,
      7
    )

    expect(companyCreateManyMock).toHaveBeenCalledTimes(1)
    const createArgs = companyCreateManyMock.mock.calls[0][0]
    expect(createArgs.data).toHaveLength(1)
    expect(createArgs.data[0].name).toBe('Key')
  })

  it('marks company changed only for relations actually inserted', async () => {
    companyFindManyMock.mockResolvedValueOnce([
      { id: 5, name: 'Key', alias: [] }
    ])
    companyRelationCreateManyMock.mockResolvedValueOnce({ count: 1 })

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbDevelopers: ['Key'] },
      NO_TAG_CHANGE,
      7
    )

    expect(companyCreateManyMock).not.toHaveBeenCalled()
    expect(invalidateCompanyCacheMock).toHaveBeenCalledTimes(1)
  })

  it('skips invalidation when nothing changed', async () => {
    companyFindManyMock.mockResolvedValueOnce([
      { id: 5, name: 'Key', alias: [] }
    ])
    companyRelationCreateManyMock.mockResolvedValueOnce({ count: 0 })

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbDevelopers: ['Key'] },
      NO_TAG_CHANGE,
      7
    )

    expect(companyCreateManyMock).not.toHaveBeenCalled()
    expect(invalidateCompanyCacheMock).not.toHaveBeenCalled()
  })
})

// 名字解析走 server/term: 会社名字优先、再按别名归并; 外部标签只认名字 (dlsite 的裁定)
describe('processSubmittedExternalData term identity', () => {
  it('links a source name that is an existing company alias instead of creating a duplicate', async () => {
    companyFindManyMock.mockResolvedValueOnce([
      { id: 9, name: 'ビジュアルアーツ', alias: ['key'] }
    ])

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, bangumiDevelopers: ['Key'] },
      NO_TAG_CHANGE,
      7
    )

    expect(companyFindManyMock.mock.calls[0][0].where).toEqual({
      OR: [{ name: { in: ['Key'] } }, { alias: { hasSome: ['Key', 'key'] } }]
    })
    expect(companyCreateManyMock).not.toHaveBeenCalled()
    expect(companyFindManyMock).toHaveBeenCalledTimes(1)
    expect(companyRelationCreateManyMock).toHaveBeenCalledWith({
      data: [{ patch_id: 1, company_id: 9 }],
      skipDuplicates: true
    })
  })

  it('prefers the company whose name matches over one that only has it as an alias', async () => {
    companyFindManyMock.mockResolvedValueOnce([
      { id: 3, name: 'Other', alias: ['Key'] },
      { id: 8, name: 'Key', alias: [] }
    ])

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbDevelopers: ['Key'] },
      NO_TAG_CHANGE,
      7
    )

    expect(companyRelationCreateManyMock).toHaveBeenCalledWith({
      data: [{ patch_id: 1, company_id: 8 }],
      skipDuplicates: true
    })
  })

  it('creates only the names that resolve to nothing and relates both kinds', async () => {
    companyFindManyMock
      .mockResolvedValueOnce([
        { id: 9, name: 'ビジュアルアーツ', alias: ['key'] }
      ])
      .mockResolvedValueOnce([{ id: 21, name: 'Navel' }])

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbDevelopers: ['Key', 'Navel'] },
      NO_TAG_CHANGE,
      7
    )

    expect(
      companyCreateManyMock.mock.calls[0][0].data.map(
        (row: { name: string }) => row.name
      )
    ).toEqual(['Navel'])
    expect(companyFindManyMock.mock.calls[1][0].where).toEqual({
      name: { in: ['Navel'] }
    })
    expect(companyRelationCreateManyMock).toHaveBeenCalledWith({
      data: [
        { patch_id: 1, company_id: 9 },
        { patch_id: 1, company_id: 21 }
      ],
      skipDuplicates: true
    })
  })

  it('matches external tags by name only, never by alias', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['NTR'] },
      NO_TAG_CHANGE,
      7
    )

    expect(tagFindManyMock.mock.calls[0][0].where).toEqual({
      name: { in: ['NTR'] }
    })
    expect(tagCreateManyMock.mock.calls[0][0].data).toEqual([
      { name: 'NTR', user_id: 7, source: 'vndb' }
    ])
  })
})

describe('processSubmittedExternalData tag length guard', () => {
  it('drops tags exceeding the 107-char column limit instead of failing the batch', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['x'.repeat(108), 'ADV'] },
      NO_TAG_CHANGE,
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
      NO_TAG_CHANGE,
      7
    )

    expect(tagFindManyMock).not.toHaveBeenCalled()
    expect(tagCreateManyMock).not.toHaveBeenCalled()
  })
})

describe('processSubmittedExternalData tag source', () => {
  it('creates DLsite tags with the dlsite source', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, dlsiteTags: ['純愛'] },
      NO_TAG_CHANGE,
      7
    )

    // DLsite 标签走外部来源通道, 不混进手动标签的差量
    expect(saveManualTagChangeMock).toHaveBeenCalledWith(1, NO_TAG_CHANGE, 7)
    expect(tagCreateManyMock).toHaveBeenCalledTimes(1)
    expect(tagCreateManyMock.mock.calls[0][0].data).toEqual([
      { name: '純愛', user_id: 7, source: 'dlsite' }
    ])
  })

  it('keeps the earlier source when DLsite repeats a VNDB tag', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['ADV'], dlsiteTags: ['ADV', '純愛'] },
      NO_TAG_CHANGE,
      7
    )

    expect(tagCreateManyMock.mock.calls[0][0].data).toEqual([
      { name: 'ADV', user_id: 7, source: 'vndb' },
      { name: '純愛', user_id: 7, source: 'dlsite' }
    ])
  })
})

describe('processSubmittedExternalData rejected task logging', () => {
  it('logs the failed task under its own label and keeps the other tasks running', async () => {
    const error = new Error('company read failed')
    companyFindManyMock.mockRejectedValueOnce(error)

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['ADV'], vndbDevelopers: ['Key'] },
      NO_TAG_CHANGE,
      7
    )

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to process external company data for patch 1:',
      error
    )
    expect(tagCreateManyMock).toHaveBeenCalledTimes(1)
    expect(invalidateTagCacheMock).toHaveBeenCalledTimes(1)
  })

  it('stays silent when every task settles, including skipped ones', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['ADV'] },
      NO_TAG_CHANGE,
      7
    )

    expect(errorSpy).not.toHaveBeenCalled()
  })
})

// 别名只由 update.ts 按 alias 全量同步. 这里若再增量补写, 用户在别名框删掉的
// Steam 别名会在同一次提交里被补回 (曾经的 steamAliases 通道)
describe('processSubmittedExternalData aliases', () => {
  it('never writes patch_alias, even for a legacy steamAliases payload', async () => {
    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, steamAliases: ['Removed Alias'] } as typeof EMPTY_DATA,
      NO_TAG_CHANGE,
      7
    )

    expect(aliasFindManyMock).not.toHaveBeenCalled()
    expect(aliasCreateManyMock).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

// 写完之后入搜索出箱归入库函数自己: 调用方各自补的时候, 有整套漏掉的, 也有排在写入之前的
// (drain 恰在两者之间消费, 之后写入的标签与会社就进不了索引, 对账只比 updated 修不回来)
describe('processSubmittedExternalData search outbox', () => {
  it('enqueues the patch once, after every write has settled', async () => {
    tagFindManyMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 3, name: 'ADV' }])
    companyFindManyMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 4, name: 'Key' }])

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['ADV'], vndbDevelopers: ['Key'] },
      { removeTagIds: [], addTagNames: ['手动'] },
      7
    )

    expect(enqueueSearchOutboxMock).toHaveBeenCalledTimes(1)
    expect(enqueueSearchOutboxMock).toHaveBeenCalledWith(prisma, 1)
    const enqueuedAt = enqueueSearchOutboxMock.mock.invocationCallOrder[0]
    for (const write of [
      saveManualTagChangeMock,
      tagCreateManyMock,
      tagRelationCreateManyMock,
      companyCreateManyMock,
      companyRelationCreateManyMock
    ]) {
      expect(write).toHaveBeenCalledTimes(1)
      expect(write.mock.invocationCallOrder[0]).toBeLessThan(enqueuedAt)
    }
  })

  // 调用方在此之前写的别名与字段也靠这一次入队收尾
  it('enqueues even when nothing external was submitted', async () => {
    await processSubmittedExternalData(1, EMPTY_DATA, NO_TAG_CHANGE, 7)

    expect(enqueueSearchOutboxMock).toHaveBeenCalledTimes(1)
    expect(enqueueSearchOutboxMock).toHaveBeenCalledWith(prisma, 1)
  })

  it('still enqueues when a task fails after part of its writes landed', async () => {
    tagFindManyMock
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('tag reread failed'))

    await processSubmittedExternalData(
      1,
      { ...EMPTY_DATA, vndbTags: ['ADV'] },
      NO_TAG_CHANGE,
      7
    )

    expect(enqueueSearchOutboxMock).toHaveBeenCalledTimes(1)
    expect(tagCreateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueSearchOutboxMock.mock.invocationCallOrder[0]
    )
  })

  // 主事务已提交, 上抛只会让建档的重试撞 P2002; 与外部数据任务同理只留痕
  it('logs an enqueue failure instead of throwing', async () => {
    const error = new Error('outbox write failed')
    enqueueSearchOutboxMock.mockRejectedValue(error)

    await expect(
      processSubmittedExternalData(
        1,
        { ...EMPTY_DATA, vndbTags: ['ADV'] },
        NO_TAG_CHANGE,
        7
      )
    ).resolves.toBeUndefined()

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to enqueue search sync for patch 1:',
      error
    )
    expect(invalidateTagCacheMock).toHaveBeenCalledTimes(1)
  })
})
