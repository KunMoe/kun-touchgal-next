// /api/search 在 Meilisearch 开启时的引擎选择: 只 mock 会话 / Redis / Prisma 与索引查询
// 这几处接缝, 引擎选择 (withMeiliEngine)、编排 (searchGalgames) 与路由都走真实代码
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SFW,
  V,
  postRequest,
  readJson
} from '~/server/viewer/__tests__/viewerMatrix'

const { findManyMock, countMock, queryGalgameIdsMock } = vi.hoisted(() => ({
  findManyMock: vi.fn(),
  countMock: vi.fn(),
  queryGalgameIdsMock: vi.fn()
}))

vi.mock(
  '~/server/auth/session',
  async () => (await import('~/server/viewer/__tests__/viewerMatrix')).jwtModule
)
vi.mock(
  '~/lib/redis',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).redisModule
)
vi.mock(
  '~/app/api/utils/pendingResourceCache',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix'))
      .pendingResourceModule
)
vi.mock('~/prisma/index', () => ({
  prisma: { patch: { findMany: findManyMock, count: countMock } }
}))
vi.mock('~/lib/meilisearch', () => ({
  isMeiliEnabled: () => true
}))
vi.mock('~/server/search/query', () => ({
  queryGalgameIds: queryGalgameIdsMock
}))

import { POST } from '~/app/api/search/route'
import { meiliApiError, meiliDown } from '~/server/search/__tests__/meiliErrors'
import { cardRow } from '~/server/galgame/__tests__/cardRow'

const BODY = {
  queryString: '[{"type":"keyword","name":"kun"}]',
  limit: 12,
  searchOption: {
    searchInIntroduction: false,
    searchInAlias: false,
    searchInTag: false
  },
  page: 1,
  selectedType: 'all',
  selectedLanguage: 'all',
  selectedPlatform: 'all',
  sortField: 'resource_update_time',
  sortOrder: 'desc',
  selectedYears: ['all'],
  selectedMonths: ['all'],
  minRatingCount: 0
}

const search = async (overrides: Record<string, unknown> = {}) => {
  const response = await POST(
    postRequest('/api/search', V.guest, { ...BODY, ...overrides })
  )
  return { status: response.status, body: await readJson(response) }
}

beforeEach(() => {
  vi.resetAllMocks()
  findManyMock.mockResolvedValue([])
  countMock.mockResolvedValue(0)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('/api/search POST 引擎选择 (Meilisearch 开启)', () => {
  it('索引正常: 卡片按索引给的顺序从 PG 取, 响应标明 meili', async () => {
    queryGalgameIdsMock.mockResolvedValue({ ids: [2, 1], total: 30 })
    findManyMock.mockResolvedValue([cardRow(1), cardRow(2)])

    const { body } = await search()

    expect(findManyMock).toHaveBeenCalledTimes(1)
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      AND: [{ id: { in: [2, 1] } }, SFW]
    })
    expect(countMock).not.toHaveBeenCalled()
    expect(body).toMatchObject({
      galgames: [{ id: 2 }, { id: 1 }],
      total: 30,
      engine: 'meili'
    })
  })

  it('Meilisearch 不可用: 换到 basic 引擎, 响应标明 basic', async () => {
    queryGalgameIdsMock.mockRejectedValue(meiliDown())
    findManyMock.mockResolvedValue([cardRow(5)])
    countMock.mockResolvedValue(1)

    const { body } = await search()

    expect(countMock).toHaveBeenCalledTimes(1)
    expect(body).toMatchObject({
      galgames: [{ id: 5 }],
      total: 1,
      engine: 'basic'
    })
  })

  // P03-02 这一类: 请求可控的 4xx 不再把搜索翻到 Prisma 路径
  it.each(['invalid_search_page', 'malformed_payload'])(
    'Meilisearch 以 %s 拒绝请求参数: 回业务错误, 不换引擎也不查库',
    async (code) => {
      queryGalgameIdsMock.mockRejectedValue(meiliApiError(400, code))

      const { status, body } = await search()

      expect(status).toBe(200)
      expect(body).toBe('搜索条件格式错误')
      expect(findManyMock).not.toHaveBeenCalled()
      expect(countMock).not.toHaveBeenCalled()
    }
  )

  it('小数页码在 schema 就被拒, 到不了任何引擎', async () => {
    const { body } = await search({ page: 1.5 })

    expect(typeof body).toBe('string')
    expect(queryGalgameIdsMock).not.toHaveBeenCalled()
    expect(findManyMock).not.toHaveBeenCalled()
  })
})
