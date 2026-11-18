import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  V,
  interactions,
  matrixState,
  postRequest,
  readJson,
  record,
  resetMatrix,
  type MatrixViewer
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

import { POST } from '~/app/api/tag/search/route'

const TAGS = [{ id: 1, name: 'kun', count: 3, alias: [] }]

// 关键词条件与视角无关; 屏蔽标签时在前面加 id.notIn
const KEYWORD_OR = [
  {
    OR: [
      { name: { contains: 'kun', mode: 'insensitive' } },
      { alias: { has: 'kun' } }
    ]
  }
]

const viaRoute = (viewer: MatrixViewer) =>
  record(viewer, async () =>
    readJson(
      await POST(postRequest('/api/tag/search', viewer, { query: ['kun'] }))
    )
  )

beforeEach(() => {
  resetMatrix()
  matrixState.prismaResults = { 'patch_tag.findMany': TAGS }
})

const anonymousViewers = [V.guest, V.guestForged, V.staleToken]

interface Row {
  viewer: MatrixViewer
  where: object
}

const rows: Row[] = [
  { viewer: V.userSfw, where: { OR: KEYWORD_OR } },
  { viewer: V.userAll, where: { OR: KEYWORD_OR } },
  { viewer: V.userNsfw, where: { OR: KEYWORD_OR } },
  // 镜像 [] 是合法缓存, 不回落 DB 的 [10, 20]
  { viewer: V.emptyMirror, where: { OR: KEYWORD_OR } },
  { viewer: V.pendingAuthor, where: { OR: KEYWORD_OR } },
  { viewer: V.admin, where: { OR: KEYWORD_OR } },
  // notIn 原样沿用解析出的顺序 (镜像 [8,7] 不排序)
  {
    viewer: V.blockerMirror,
    where: { id: { notIn: [8, 7] }, OR: KEYWORD_OR }
  },
  {
    viewer: V.blockerDb,
    where: { id: { notIn: [10, 20] }, OR: KEYWORD_OR }
  },
  {
    viewer: V.blockerBadEscape,
    where: { id: { notIn: [10, 20] }, OR: KEYWORD_OR }
  },
  {
    viewer: V.blockerBadJson,
    where: { id: { notIn: [10, 20] }, OR: KEYWORD_OR }
  },
  {
    viewer: V.adminBlocker,
    where: { id: { notIn: [7, 8] }, OR: KEYWORD_OR }
  }
]

describe('标签搜索 /api/tag/search 视角矩阵 (无页面读取器)', () => {
  it.each(anonymousViewers)('route: $name → 用户未登录', async (viewer) => {
    const recording = await viaRoute(viewer)

    expect(recording.result).toBe('用户未登录')
    expect(interactions(recording)).toEqual({
      prisma: [],
      redis: [],
      meili: []
    })
  })

  it.each(rows)('route: $viewer.name', async (row) => {
    const recording = await viaRoute(row.viewer)

    expect(recording.prisma).toEqual([
      { call: 'patch_tag.findMany', where: row.where }
    ])
    // 标签搜索不走任何缓存
    expect(recording.redis).toEqual([])
    expect(recording.result).toEqual(TAGS)
  })
})
