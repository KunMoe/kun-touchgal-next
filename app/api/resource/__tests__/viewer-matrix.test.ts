import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_STATUS,
  ALL,
  NSFW_ONLY,
  PUBLIC_STATUS,
  SFW,
  SFW_BLOCK_10_20,
  SFW_BLOCK_7_8,
  V,
  getRequest,
  interactions,
  matrixState,
  ownStatus,
  readJson,
  record,
  resetMatrix,
  sharedMissTrace,
  type MatrixViewer,
  type RedisCall
} from '~/server/viewer/__tests__/viewerMatrix'

vi.mock(
  '~/app/api/utils/jwt',
  async () => (await import('~/server/viewer/__tests__/viewerMatrix')).jwtModule
)
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
  'next/headers',
  async () =>
    (await import('~/server/viewer/__tests__/viewerMatrix')).nextHeadersModule
)
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: (await import('~/server/viewer/__tests__/viewerMatrix')).memoCache
}))

import { GET } from '~/app/api/resource/route'
import { kunGetActions } from '~/app/resource/actions'

const CONTENT_VERSION_KEY = 'resource:list:version:content'
const STATS_VERSION_KEY = 'resource:list:version:stats'
// 版本键预置为非默认值, 证明版本号进了列表键
const VERSION_SEED = {
  [CONTENT_VERSION_KEY]: 'rc1',
  [STATS_VERSION_KEY]: 'rs1'
}

// 键 = 'resource:list:' + sha1(<content>|<stats>|<sortField>|<sortOrder>|<page>|<limit>|<视角>).hex.slice(0, 16)
// created 排序只读内容版本, 统计版本恒为 '0'; download / like 排序两个版本都读
const CREATED_SFW_KEY = 'resource:list:0a902f67ec675903' // sha1('rc1|0|created|desc|1|24|sfw:')
const CREATED_ALL_KEY = 'resource:list:af91db6c2694b3b4' // sha1('rc1|0|created|desc|1|24|all:')
const CREATED_NSFW_KEY = 'resource:list:cd3ff9bbf2ae1a16' // sha1('rc1|0|created|desc|1|24|nsfw:')
const DOWNLOAD_SFW_KEY = 'resource:list:37b937e80d0666f2' // sha1('rc1|rs1|download|desc|1|24|sfw:')
const DOWNLOAD_ALL_KEY = 'resource:list:83568668d7b73066' // sha1('rc1|rs1|download|desc|1|24|all:')
const RESOURCE_TTL = 60

type SortField = 'created' | 'download'

const versionRead = (sortField: SortField): RedisCall => [
  'getKvs',
  sortField === 'created'
    ? [CONTENT_VERSION_KEY]
    : [CONTENT_VERSION_KEY, STATS_VERSION_KEY]
]

const sharedTrace = (sortField: SortField, key: string): RedisCall[] => [
  versionRead(sortField),
  ...sharedMissTrace(key, RESOURCE_TTL)
]

const resourceQueries = (patch: object, status: object) => {
  const where = { patch, section: 'patch', ...status }
  return [
    { call: 'patch_resource.findMany', where },
    { call: 'patch_resource.count', where }
  ]
}

interface ResourceRow {
  viewer: MatrixViewer
  sortField: SortField
  patch: object
  status: object
  redis: RedisCall[]
}

// 共享视角读版本键并读写共享列表键; 屏蔽视角与个人视角 cacheKey 为 null,
// 连版本键都不读, 完全不碰 Redis
const createdRows: ResourceRow[] = [
  {
    viewer: V.guest,
    sortField: 'created',
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedTrace('created', CREATED_SFW_KEY)
  },
  {
    viewer: V.guestForged,
    sortField: 'created',
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedTrace('created', CREATED_SFW_KEY)
  },
  {
    viewer: V.staleToken,
    sortField: 'created',
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedTrace('created', CREATED_SFW_KEY)
  },
  {
    viewer: V.userSfw,
    sortField: 'created',
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedTrace('created', CREATED_SFW_KEY)
  },
  {
    viewer: V.userAll,
    sortField: 'created',
    patch: ALL,
    status: PUBLIC_STATUS,
    redis: sharedTrace('created', CREATED_ALL_KEY)
  },
  {
    viewer: V.userNsfw,
    sortField: 'created',
    patch: NSFW_ONLY,
    status: PUBLIC_STATUS,
    redis: sharedTrace('created', CREATED_NSFW_KEY)
  },
  {
    viewer: V.blockerMirror,
    sortField: 'created',
    patch: SFW_BLOCK_7_8,
    status: PUBLIC_STATUS,
    redis: []
  },
  {
    viewer: V.blockerDb,
    sortField: 'created',
    patch: SFW_BLOCK_10_20,
    status: PUBLIC_STATUS,
    redis: []
  },
  {
    viewer: V.blockerBadEscape,
    sortField: 'created',
    patch: SFW_BLOCK_10_20,
    status: PUBLIC_STATUS,
    redis: []
  },
  {
    viewer: V.blockerBadJson,
    sortField: 'created',
    patch: SFW_BLOCK_10_20,
    status: PUBLIC_STATUS,
    redis: []
  },
  {
    viewer: V.emptyMirror,
    sortField: 'created',
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedTrace('created', CREATED_SFW_KEY)
  },
  {
    viewer: V.pendingAuthor,
    sortField: 'created',
    patch: SFW,
    status: ownStatus(31),
    redis: []
  },
  {
    viewer: V.admin,
    sortField: 'created',
    patch: SFW,
    status: ADMIN_STATUS,
    redis: []
  },
  {
    viewer: V.adminBlocker,
    sortField: 'created',
    patch: SFW_BLOCK_7_8,
    status: ADMIN_STATUS,
    redis: []
  }
]

// 统计版本参与键的排序字段
const downloadRows: ResourceRow[] = [
  {
    viewer: V.guest,
    sortField: 'download',
    patch: SFW,
    status: PUBLIC_STATUS,
    redis: sharedTrace('download', DOWNLOAD_SFW_KEY)
  },
  {
    viewer: V.userAll,
    sortField: 'download',
    patch: ALL,
    status: PUBLIC_STATUS,
    redis: sharedTrace('download', DOWNLOAD_ALL_KEY)
  },
  {
    viewer: V.blockerMirror,
    sortField: 'download',
    patch: SFW_BLOCK_7_8,
    status: PUBLIC_STATUS,
    redis: []
  },
  {
    viewer: V.pendingAuthor,
    sortField: 'download',
    patch: SFW,
    status: ownStatus(31),
    redis: []
  },
  {
    viewer: V.admin,
    sortField: 'download',
    patch: SFW,
    status: ADMIN_STATUS,
    redis: []
  }
]

const params = (sortField: SortField) =>
  ({ sortField, sortOrder: 'desc', page: 1, limit: 24 }) as const

const viaRoute = (viewer: MatrixViewer, sortField: SortField) =>
  record(viewer, async () =>
    readJson(
      await GET(
        getRequest(
          `/api/resource?sortField=${sortField}&sortOrder=desc&page=1&limit=24`,
          viewer
        )
      )
    )
  )

const viaLoader = (viewer: MatrixViewer, sortField: SortField) =>
  record(viewer, () => kunGetActions(params(sortField)))

beforeEach(() => {
  resetMatrix()
  matrixState.redisSeed = VERSION_SEED
})

describe.each([
  ['created', createdRows],
  ['download', downloadRows]
] as const)(
  '资源列表 /api/resource ↔ app/resource/actions.ts (sortField=%s)',
  (_sortField, rows) => {
    it.each(rows)('route: $viewer.name', async (row) => {
      const recording = await viaRoute(row.viewer, row.sortField)

      expect(recording.prisma).toEqual(resourceQueries(row.patch, row.status))
      expect(recording.redis).toEqual(row.redis)
      expect(recording.result).toEqual({ resources: [], total: 0 })
    })

    it.each(rows)('loader: $viewer.name', async (row) => {
      const recording = await viaLoader(row.viewer, row.sortField)

      expect(recording.prisma).toEqual(resourceQueries(row.patch, row.status))
      expect(recording.redis).toEqual(row.redis)
      expect(recording.result).toEqual({ resources: [], total: 0 })
    })

    it.each(rows)('route ≡ loader: $viewer.name', async (row) => {
      const route = await viaRoute(row.viewer, row.sortField)
      const loader = await viaLoader(row.viewer, row.sortField)

      expect(interactions(loader)).toEqual(interactions(route))
      expect(loader.result).toEqual(route.result)
    })
  }
)
