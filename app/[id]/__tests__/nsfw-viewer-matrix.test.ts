import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidElement } from 'react'
import {
  V,
  record,
  resetMatrix,
  type MatrixViewer
} from '~/server/viewer/__tests__/viewerMatrix'

const {
  kunGetPatchPageDataActionsMock,
  kunUpdatePatchViewsActionsMock,
  kunGetResourceDetailActionsMock,
  patchMetadataMock,
  resourceMetadataMock
} = vi.hoisted(() => ({
  kunGetPatchPageDataActionsMock: vi.fn(),
  kunUpdatePatchViewsActionsMock: vi.fn(),
  kunGetResourceDetailActionsMock: vi.fn(),
  patchMetadataMock: vi.fn(),
  resourceMetadataMock: vi.fn()
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
// app/[id]/page.tsx 在渲染后调用 after() 记浏览量; 真实 after 在请求作用域外会抛错
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn()
}))

vi.mock('~/app/[id]/actions', () => ({
  kunGetPatchPageDataActions: kunGetPatchPageDataActionsMock,
  kunUpdatePatchViewsActions: kunUpdatePatchViewsActionsMock
}))
vi.mock('~/app/[id]/metadata', () => ({
  generateKunMetadataTemplate: patchMetadataMock
}))
vi.mock('~/app/[id]/resource/[resourceId]/actions', () => ({
  kunGetResourceDetailActions: kunGetResourceDetailActionsMock
}))
vi.mock('~/app/[id]/resource/[resourceId]/metadata', () => ({
  generateKunMetadataTemplate: resourceMetadataMock
}))

// 子组件只作为元素类型出现, 不渲染; 替换掉以免拉进整套客户端组件
vi.mock('~/components/patch/header/Container', () => ({
  PatchHeaderContainer: vi.fn(() => null)
}))
vi.mock('~/components/error/ErrorComponent', () => ({
  ErrorComponent: vi.fn(() => null)
}))
vi.mock('~/components/kun/BreadcrumbTitle', () => ({
  KunBreadcrumbTitle: vi.fn(() => null)
}))
vi.mock('~/components/patch/resource-detail/ResourceDetail', () => ({
  ResourceDetail: vi.fn(() => null)
}))
vi.mock('~/components/kun/Null', () => ({
  KunNull: vi.fn(() => null)
}))

import PatchPage, {
  generateMetadata as generatePatchMetadata
} from '~/app/[id]/page'
import ResourcePage, {
  generateMetadata as generateResourceMetadata
} from '~/app/[id]/resource/[resourceId]/page'
import { PatchHeaderContainer } from '~/components/patch/header/Container'
import { KunBreadcrumbTitle } from '~/components/kun/BreadcrumbTitle'
import { ResourceDetail } from '~/components/patch/resource-detail/ResourceDetail'
import { KunNull } from '~/components/kun/Null'

interface RenderedElement {
  type: unknown
  props: Record<string, unknown> & { children?: unknown }
}

// 只看直接子元素 (页面根是一个 div, 关心的组件都在第一层)
const childrenOf = (element: RenderedElement): RenderedElement[] => {
  const { children } = element.props
  const list = Array.isArray(children) ? children : [children]
  return list.filter((child): child is RenderedElement => isValidElement(child))
}

const findByType = (element: RenderedElement, type: unknown) =>
  childrenOf(element).filter((child) => child.type === type)

const PATCH_ID = 'abcd1234'
const RESOURCE_ID = '77'

const buildPageData = (contentLimit: 'sfw' | 'nsfw') => ({
  patch: {
    uniqueId: PATCH_ID,
    name: '鲲',
    alias: ['kun'],
    platform: ['windows'],
    contentLimit
  },
  intro: { introduction: '' }
})

const RESOURCE_DETAIL = {
  resource: {
    id: 77,
    uniqueId: PATCH_ID,
    name: 'kun 补丁',
    section: 'patch'
  },
  patchName: '鲲',
  contentLimit: 'nsfw'
}

// getPatchPageTitle(buildPageData(..).patch): 有别名、平台只有 windows
const PATCH_TITLE = '鲲 | kun | PC 游戏'

interface NsfwRow {
  viewer: MatrixViewer
  nsfwAllowed: boolean
  uid: number | undefined
}

// NSFW 只在已登录且 cookie 为 all / nsfw 时放开; 伪造 cookie 与失效 token 一律按游客 sfw
const rows: NsfwRow[] = [
  { viewer: V.guest, nsfwAllowed: false, uid: undefined },
  { viewer: V.guestForged, nsfwAllowed: false, uid: undefined },
  { viewer: V.staleToken, nsfwAllowed: false, uid: undefined },
  { viewer: V.userSfw, nsfwAllowed: false, uid: 11 },
  { viewer: V.userAll, nsfwAllowed: true, uid: 12 },
  { viewer: V.userNsfw, nsfwAllowed: true, uid: 13 }
]

const patchProps = { params: Promise.resolve({ id: PATCH_ID }) }
const resourceProps = {
  params: Promise.resolve({ id: PATCH_ID, resourceId: RESOURCE_ID })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetMatrix()
  kunGetPatchPageDataActionsMock.mockResolvedValue(buildPageData('nsfw'))
  kunGetResourceDetailActionsMock.mockResolvedValue(RESOURCE_DETAIL)
  patchMetadataMock.mockReturnValue({})
  resourceMetadataMock.mockReturnValue({})
})

describe('app/[id]/page 默认导出: NSFW 视角', () => {
  it.each(rows)('nsfw 作品: $viewer.name', async (row) => {
    const recording = await record(
      row.viewer,
      async () => (await PatchPage(patchProps)) as RenderedElement
    )
    const element = recording.result

    expect(findByType(element, KunBreadcrumbTitle).map((c) => c.props)).toEqual(
      [
        {
          routeKey: `/${PATCH_ID}`,
          title: row.nsfwAllowed ? PATCH_TITLE : ''
        }
      ]
    )
    expect(
      findByType(element, PatchHeaderContainer).map((c) => c.props)
    ).toEqual([
      {
        patch: buildPageData('nsfw').patch,
        intro: buildPageData('nsfw').intro,
        uid: row.uid,
        nsfwAllowed: row.nsfwAllowed
      }
    ])
    expect(recording.prisma).toEqual([])
    expect(recording.redis).toEqual([])
  })

  it.each(rows)('sfw 作品标题对谁都不隐藏: $viewer.name', async (row) => {
    kunGetPatchPageDataActionsMock.mockResolvedValue(buildPageData('sfw'))

    const recording = await record(
      row.viewer,
      async () => (await PatchPage(patchProps)) as RenderedElement
    )
    const element = recording.result

    expect(findByType(element, KunBreadcrumbTitle).map((c) => c.props)).toEqual(
      [{ routeKey: `/${PATCH_ID}`, title: PATCH_TITLE }]
    )
    expect(
      findByType(element, PatchHeaderContainer).map((c) => c.props.nsfwAllowed)
    ).toEqual([row.nsfwAllowed])
  })
})

describe('app/[id]/page generateMetadata: NSFW 视角', () => {
  it.each(rows)('$viewer.name', async (row) => {
    const recording = await record(row.viewer, () =>
      generatePatchMetadata(patchProps)
    )

    expect(recording.result).toEqual({})
    expect(patchMetadataMock).toHaveBeenCalledTimes(1)
    expect(patchMetadataMock).toHaveBeenCalledWith(
      buildPageData('nsfw').patch,
      buildPageData('nsfw').intro,
      row.nsfwAllowed
    )
    expect(recording.prisma).toEqual([])
    expect(recording.redis).toEqual([])
  })
})

describe('app/[id]/resource/[resourceId]/page 默认导出: NSFW 视角', () => {
  it.each(rows)('nsfw 资源: $viewer.name', async (row) => {
    const recording = await record(
      row.viewer,
      async () => (await ResourcePage(resourceProps)) as RenderedElement
    )
    const element = recording.result

    expect(findByType(element, KunBreadcrumbTitle).map((c) => c.props)).toEqual(
      [
        { routeKey: `/${PATCH_ID}`, title: row.nsfwAllowed ? '鲲' : '' },
        {
          routeKey: `/${PATCH_ID}/resource/77`,
          title: row.nsfwAllowed ? 'kun 补丁' : ''
        }
      ]
    )

    if (row.nsfwAllowed) {
      expect(findByType(element, KunNull)).toEqual([])
      expect(findByType(element, ResourceDetail).map((c) => c.props)).toEqual([
        { detail: RESOURCE_DETAIL, isLoggedIn: true }
      ])
    } else {
      expect(findByType(element, ResourceDetail)).toEqual([])
      expect(findByType(element, KunNull).map((c) => c.props)).toEqual([
        {
          message:
            row.uid === undefined
              ? '请登录后查看'
              : '请在右上角菜单开启 NSFW 内容显示后查看'
        }
      ])
    }
    expect(recording.prisma).toEqual([])
    expect(recording.redis).toEqual([])
  })
})

describe('app/[id]/resource/[resourceId]/page generateMetadata: NSFW 视角', () => {
  it.each(rows)('$viewer.name', async (row) => {
    const recording = await record(row.viewer, () =>
      generateResourceMetadata(resourceProps)
    )

    expect(recording.result).toEqual({})
    expect(kunGetResourceDetailActionsMock).toHaveBeenCalledWith(77)
    expect(resourceMetadataMock).toHaveBeenCalledTimes(1)
    expect(resourceMetadataMock).toHaveBeenCalledWith(
      RESOURCE_DETAIL,
      row.nsfwAllowed
    )
    expect(recording.prisma).toEqual([])
    expect(recording.redis).toEqual([])
  })
})
