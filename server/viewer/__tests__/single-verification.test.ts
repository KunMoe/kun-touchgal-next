import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  V,
  getRequest,
  postRequest,
  record,
  resetMatrix,
  type MatrixViewer
} from '~/server/viewer/__tests__/viewerMatrix'

// 一个请求只校验一次会话: 校验带登录会话的续期与清理 (Redis 读写)。在 Route Handler 里
// 每建一个视角上下文、每调一次 verifyHeaderCookie(req) 都会再校验一次, 页面侧则靠
// React cache 共用同一个上下文。视角矩阵的用例刻意不数校验次数, 这里逐个入口数
const { verifyMock } = vi.hoisted(() => ({ verifyMock: vi.fn() }))

vi.mock('~/app/api/utils/jwt', async () => {
  const { jwtModule } = await import('~/server/viewer/__tests__/viewerMatrix')
  verifyMock.mockImplementation(jwtModule.verifyKunTokenWithUser)
  return { verifyKunTokenWithUser: verifyMock }
})
vi.mock(
  '~/lib/redis',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).redisModule
)
vi.mock(
  '~/prisma/index',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).prismaModule
)
vi.mock(
  '~/prisma',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).prismaModule
)
vi.mock(
  '~/app/api/utils/pendingResourceCache',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix'))
      .pendingResourceModule
)
vi.mock(
  '~/lib/meilisearch',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).meiliModule
)
vi.mock(
  '~/server/search/query',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).searchQueryModule
)
vi.mock(
  '~/server/search/resolve',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).searchResolveModule
)
vi.mock(
  'next/headers',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).nextHeadersModule
)
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: (await import('~/server/viewer/__tests__/viewerMatrix')).memoCache
}))
vi.mock('~/app/api/tag/get', () => ({
  getTagById: async () => ({ id: 13, name: 'kun' })
}))
vi.mock('~/app/api/company/service', () => ({
  getCompanyById: async () => ({ id: 8, name: 'kun' })
}))

import { GET as homeGET } from '~/app/api/home/route'
import { GET as resourceGET } from '~/app/api/resource/route'
import { GET as randomGET } from '~/app/api/home/random/route'
import { GET as profileResourceGET } from '~/app/api/user/profile/resource/route'
import { GET as galgameGET } from '~/app/api/galgame/route'
import { GET as tagGalgameGET } from '~/app/api/tag/galgame/route'
import { GET as companyGalgameGET } from '~/app/api/company/galgame/route'
import { POST as searchPOST } from '~/app/api/search/route'
import { GET as tagAllGET } from '~/app/api/tag/all/route'
import { POST as tagSearchPOST } from '~/app/api/tag/search/route'
import { GET as adminGalgameGET } from '~/app/api/admin/galgame/route'
import { GET as adminResourceGET } from '~/app/api/admin/resource/route'
import { GET as adminResourceApplyGET } from '~/app/api/admin/resource-apply/route'
import { kunGetActions as homeLoader } from '~/app/actions'
import { kunGetActions as resourceLoader } from '~/app/resource/actions'
import { kunGetActions as galgameLoader } from '~/app/galgame/actions'
import { kunGetActions as tagLoader } from '~/app/tag/actions'
import {
  kunGetTagMetadataActions,
  kunGetTagPageDataActions
} from '~/app/tag/[id]/actions'
import { kunGetCompanyPageDataActions } from '~/app/company/[id]/actions'
import { kunGetActions as profileResourceLoader } from '~/app/user/[id]/resource/actions'
import { kunGetActions as adminGalgameLoader } from '~/app/admin/galgame/actions'
import { kunGetActions as adminResourceLoader } from '~/app/admin/resource/actions'
import { kunGetActions as adminResourceApplyLoader } from '~/app/admin/resource-apply/actions'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'

const LIST = 'sortField=resource_update_time&sortOrder=desc&page=1&limit=24'
const LIST_PARAMS = {
  selectedType: 'all',
  selectedLanguage: 'all',
  selectedPlatform: 'all',
  sortField: 'resource_update_time',
  sortOrder: 'desc',
  page: 1,
  limit: 24,
  yearString: '["all"]',
  monthString: '["all"]',
  minRatingCount: 0
} as const
const SEARCH_BODY = {
  queryString: '[{"type":"keyword","name":"kun"}]',
  limit: 24,
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

// 每个入口都用「最费会话」的视角: 既有分级设置或屏蔽镜像, 又是能看到待审核内容的角色
const routes: [string, MatrixViewer, (viewer: MatrixViewer) => unknown][] = [
  ['GET /api/home', V.adminBlocker, (v) => homeGET(getRequest('/api/home', v))],
  [
    'GET /api/resource',
    V.adminBlocker,
    (v) =>
      resourceGET(
        getRequest(
          '/api/resource?sortField=created&sortOrder=desc&page=1&limit=24',
          v
        )
      )
  ],
  [
    'GET /api/home/random',
    V.adminBlocker,
    (v) => randomGET(getRequest('/api/home/random', v))
  ],
  [
    'GET /api/user/profile/resource',
    V.adminBlocker,
    (v) =>
      profileResourceGET(
        getRequest('/api/user/profile/resource?uid=1&page=1&limit=20', v)
      )
  ],
  [
    'GET /api/galgame',
    V.adminBlocker,
    (v) => galgameGET(getRequest(`/api/galgame?${LIST}`, v))
  ],
  [
    'GET /api/tag/galgame',
    V.adminBlocker,
    (v) => tagGalgameGET(getRequest(`/api/tag/galgame?tagId=13&${LIST}`, v))
  ],
  [
    'GET /api/company/galgame',
    V.adminBlocker,
    (v) =>
      companyGalgameGET(
        getRequest(`/api/company/galgame?companyId=8&${LIST}`, v)
      )
  ],
  [
    'POST /api/search',
    V.adminBlocker,
    (v) => searchPOST(postRequest('/api/search', v, SEARCH_BODY))
  ],
  [
    'GET /api/tag/all',
    V.adminBlocker,
    (v) => tagAllGET(getRequest('/api/tag/all?page=1&limit=100', v))
  ],
  [
    'POST /api/tag/search',
    V.adminBlocker,
    (v) => tagSearchPOST(postRequest('/api/tag/search', v, { query: ['kun'] }))
  ],
  [
    'GET /api/admin/galgame',
    V.superAdminBlocker,
    (v) => adminGalgameGET(getRequest('/api/admin/galgame?page=1&limit=24', v))
  ],
  [
    'GET /api/admin/resource',
    V.superAdminBlocker,
    (v) =>
      adminResourceGET(getRequest('/api/admin/resource?page=1&limit=24', v))
  ],
  [
    'GET /api/admin/resource-apply',
    V.superAdminBlocker,
    (v) =>
      adminResourceApplyGET(
        getRequest('/api/admin/resource-apply?page=1&limit=24', v)
      )
  ]
]

// 一次渲染里页面常常既要 payload 又要读取器的数据: 两者必须落在同一个上下文上
const renders: [string, MatrixViewer, () => Promise<unknown>][] = [
  ['app/actions', V.adminBlocker, () => homeLoader()],
  [
    'app/resource/actions',
    V.adminBlocker,
    () =>
      resourceLoader({
        sortField: 'created',
        sortOrder: 'desc',
        page: 1,
        limit: 24
      })
  ],
  ['app/galgame/actions', V.adminBlocker, () => galgameLoader(LIST_PARAMS)],
  [
    'app/tag/page 的取数 (payload + 读取器)',
    V.adminBlocker,
    async () => [
      await verifyHeaderCookie(),
      await tagLoader({ page: 1, limit: 100 })
    ]
  ],
  [
    'app/tag/[id] 的 metadata 与页面数据',
    V.adminBlocker,
    () =>
      Promise.all([
        kunGetTagMetadataActions({ tagId: 13 }),
        kunGetTagPageDataActions({ ...LIST_PARAMS, tagId: 13 })
      ])
  ],
  [
    'app/company/[id]/actions',
    V.adminBlocker,
    () => kunGetCompanyPageDataActions({ ...LIST_PARAMS, companyId: 8 })
  ],
  [
    'app/user/[id]/resource/actions',
    V.adminBlocker,
    () => profileResourceLoader({ uid: 1, page: 1, limit: 20 })
  ],
  [
    'app/admin/galgame/actions',
    V.superAdminBlocker,
    () => adminGalgameLoader({ page: 1, limit: 24 })
  ],
  [
    'app/admin/resource/actions',
    V.superAdminBlocker,
    () => adminResourceLoader({ page: 1, limit: 24, searchType: 'content' })
  ],
  [
    'app/admin/resource-apply/actions',
    V.superAdminBlocker,
    () => adminResourceApplyLoader({ page: 1, limit: 24 })
  ]
]

beforeEach(() => {
  resetMatrix()
  verifyMock.mockClear()
})

describe('一个请求只校验一次会话', () => {
  it.each(routes)('%s: 登录请求 1 次, 游客 0 次', async (_, viewer, call) => {
    await record(viewer, async () => call(viewer))
    expect(verifyMock).toHaveBeenCalledTimes(1)

    verifyMock.mockClear()
    await record(V.guestForged, async () => call(V.guestForged))
    expect(verifyMock).not.toHaveBeenCalled()
  })

  it.each(renders)(
    '%s: 一次渲染 1 次, 游客 0 次',
    async (_, viewer, render) => {
      await record(viewer, render)
      expect(verifyMock).toHaveBeenCalledTimes(1)

      verifyMock.mockClear()
      await record(V.guestForged, render)
      expect(verifyMock).not.toHaveBeenCalled()
    }
  )
})
