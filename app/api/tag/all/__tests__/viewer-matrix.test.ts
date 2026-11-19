import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Suspense } from 'react'
import {
  V,
  getRequest,
  interactions,
  matrixState,
  readJson,
  record,
  resetMatrix,
  type MatrixViewer,
  type RedisCall
} from '~/server/viewer/__tests__/viewerMatrix'

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

// 子组件只作为元素类型出现, 不渲染; 替换掉以免拉进整套客户端组件
vi.mock('~/components/tag/Container', () => ({ Container: vi.fn(() => null) }))
vi.mock('~/components/error/ErrorComponent', () => ({
  ErrorComponent: vi.fn(() => null)
}))

import { GET } from '~/app/api/tag/all/route'
import TagPage from '~/app/tag/page'
import { Container } from '~/components/tag/Container'

// 键 = 'tag:list:' + sha1(<版本>|<page>|<limit>|<去重升序的屏蔽标签>).hex.slice(0, 16)
const TAG_LIST_VERSION_KEY = 'tag:list:version'
const TAG_LIST_KEY = 'tag:list:97468a9da83818a4' // sha1('tv1|1|100|')
const TAG_LIST_TTL = 300

const TAGS = [{ id: 1, name: '纯爱', count: 3, alias: ['pure'] }]
const TOTAL = 1

// 标签列表缓存不走单飞: 读版本 → 读列表键 → 回源后直接写
const sharedTagListTrace: RedisCall[] = [
  ['getKv', TAG_LIST_VERSION_KEY],
  ['getKv', TAG_LIST_KEY],
  ['setKv', TAG_LIST_KEY, TAG_LIST_TTL]
]

const tagQueries = (where: object | undefined) => [
  { call: 'patch_tag.findMany', where },
  { call: 'patch_tag.count', where }
]

interface RenderedElement {
  type: unknown
  props: Record<string, unknown> & { children?: unknown }
}

const viaRoute = (viewer: MatrixViewer) =>
  record(viewer, async () =>
    readJson(await GET(getRequest('/api/tag/all?page=1&limit=100', viewer)))
  )

const viaPage = (viewer: MatrixViewer) =>
  record(viewer, async () => (await TagPage()) as RenderedElement)

// 页面结构: <Suspense><Container .../></Suspense>
const containerProps = (element: RenderedElement) => {
  expect(element.type).toBe(Suspense)
  const child = element.props.children as RenderedElement
  expect(child.type).toBe(Container)
  return child.props
}

beforeEach(() => {
  resetMatrix()
  matrixState.redisSeed = { [TAG_LIST_VERSION_KEY]: 'tv1' }
  matrixState.prismaResults = {
    'patch_tag.findMany': TAGS,
    'patch_tag.count': TOTAL
  }
})

// 未登录 (含伪造 cookie / 失效 token): 路由报错, 页面渲染空容器; 两侧都不查库不碰 Redis
const anonymousViewers = [V.guest, V.guestForged, V.staleToken]

interface SharedRow {
  viewer: MatrixViewer
  uid: number
}

// 已登录且没有屏蔽标签: 读写共享标签列表键, where 为 undefined
const sharedRows: SharedRow[] = [
  { viewer: V.userSfw, uid: 11 },
  { viewer: V.userAll, uid: 12 },
  { viewer: V.userNsfw, uid: 13 },
  // DB 里没有屏蔽: cookie 里那份 [7, 8] 的副本不被采信
  { viewer: V.mirrorOnly, uid: 25 },
  // 标签列表与 NSFW / 待审资源 / 角色无关
  { viewer: V.pendingAuthor, uid: 31 },
  { viewer: V.admin, uid: 41 }
]

interface BlockedRow {
  viewer: MatrixViewer
  uid: number
  notIn: number[]
}

// 带屏蔽标签: 不进共享缓存 (零 Redis 交互), notIn 原样沿用 DB 里的顺序 (不排序)
const blockedRows: BlockedRow[] = [
  { viewer: V.blockerMirror, uid: 21, notIn: [10, 20] },
  { viewer: V.blockerDb, uid: 22, notIn: [10, 20] },
  { viewer: V.blockerBadEscape, uid: 23, notIn: [10, 20] },
  { viewer: V.blockerBadJson, uid: 24, notIn: [10, 20] },
  { viewer: V.adminBlocker, uid: 42, notIn: [7, 8] }
]

const loggedInRows = [
  ...sharedRows.map((row) => ({
    ...row,
    where: undefined as object | undefined,
    redis: sharedTagListTrace
  })),
  ...blockedRows.map((row) => ({
    ...row,
    where: { id: { notIn: row.notIn } } as object | undefined,
    redis: [] as RedisCall[]
  }))
]

describe('标签列表 /api/tag/all ↔ app/tag/page.tsx 视角矩阵', () => {
  describe('未登录视角: 路由与页面的分歧 (路由报错, 页面给空容器)', () => {
    it.each(anonymousViewers)('route: $name → 用户未登录', async (viewer) => {
      const recording = await viaRoute(viewer)

      expect(recording.result).toBe('用户未登录')
      expect(interactions(recording)).toEqual({
        prisma: [],
        redis: [],
        meili: []
      })
    })

    it.each(anonymousViewers)('page: $name → 空容器无 uid', async (viewer) => {
      const recording = await viaPage(viewer)

      expect(containerProps(recording.result)).toEqual({
        initialTags: [],
        initialTotal: 0
      })
      expect(interactions(recording)).toEqual({
        prisma: [],
        redis: [],
        meili: []
      })
    })
  })

  it.each(loggedInRows)('route: $viewer.name', async (row) => {
    const recording = await viaRoute(row.viewer)

    expect(recording.prisma).toEqual(tagQueries(row.where))
    expect(recording.redis).toEqual(row.redis)
    expect(recording.result).toEqual({ tags: TAGS, total: TOTAL })
  })

  it.each(loggedInRows)('page: $viewer.name', async (row) => {
    const recording = await viaPage(row.viewer)

    expect(recording.prisma).toEqual(tagQueries(row.where))
    expect(recording.redis).toEqual(row.redis)
    expect(containerProps(recording.result)).toEqual({
      initialTags: TAGS,
      initialTotal: TOTAL,
      uid: row.uid
    })
  })

  it.each(loggedInRows)('route ≡ page: $viewer.name', async (row) => {
    const route = await viaRoute(row.viewer)
    const page = await viaPage(row.viewer)

    expect(interactions(page)).toEqual(interactions(route))
    const props = containerProps(page.result)
    expect({ tags: props.initialTags, total: props.initialTotal }).toEqual(
      route.result
    )
  })

  it('共享键命中时直接返回缓存, 不查库', async () => {
    const cached = { tags: [{ id: 9, name: '治愈', count: 1, alias: [] }] }
    const cachedResponse = { ...cached, total: 1 }
    matrixState.redisSeed = {
      [TAG_LIST_VERSION_KEY]: 'tv1',
      [TAG_LIST_KEY]: JSON.stringify(cachedResponse)
    }

    const route = await viaRoute(V.userSfw)
    expect(route.result).toEqual(cachedResponse)
    expect(route.prisma).toEqual([])
    expect(route.redis).toEqual([
      ['getKv', TAG_LIST_VERSION_KEY],
      ['getKv', TAG_LIST_KEY]
    ])

    const page = await viaPage(V.userSfw)
    expect(containerProps(page.result)).toEqual({
      initialTags: cachedResponse.tags,
      initialTotal: 1,
      uid: 11
    })
    expect(interactions(page)).toEqual(interactions(route))
  })
})
