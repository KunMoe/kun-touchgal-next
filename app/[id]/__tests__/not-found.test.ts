import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunGetPatchPageDataActionsMock,
  kunUpdatePatchViewsActionsMock,
  kunGetResourceDetailActionsMock,
  patchMetadataMock,
  resourceMetadataMock,
  afterMock
} = vi.hoisted(() => ({
  kunGetPatchPageDataActionsMock: vi.fn(),
  kunUpdatePatchViewsActionsMock: vi.fn(),
  kunGetResourceDetailActionsMock: vi.fn(),
  patchMetadataMock: vi.fn(),
  resourceMetadataMock: vi.fn(),
  afterMock: vi.fn()
}))

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: afterMock
}))

vi.mock('~/utils/actions/verifyHeaderCookie', () => ({
  verifyHeaderCookie: async () => null
}))
vi.mock('~/server/viewer/fromHeaders', () => ({
  getViewerContext: async () => ({
    visibility: async () => ({ contentLimit: 'sfw' })
  })
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

// next/navigation 的 notFound() 抛出的错误 (文档写明的 digest); 读取器被 mock 掉,
// 用同样形状的错误代替它在「不存在」时抛出的那一个
const NOT_FOUND = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }
const notFoundError = () =>
  Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), NOT_FOUND)

const PATCH_ID = 'abcd1234'
const PAGE_DATA = {
  patch: {
    uniqueId: PATCH_ID,
    name: '鲲',
    alias: [],
    platform: ['windows'],
    contentLimit: 'sfw'
  },
  intro: {}
}
const detailOf = (uniqueId: string) => ({
  contentLimit: 'sfw',
  patchName: '鲲',
  resource: { id: 77, uniqueId, name: 'kun 补丁', section: 'patch' }
})

const patchProps = (id = PATCH_ID) => ({ params: Promise.resolve({ id }) })
const resourceProps = (id = PATCH_ID, resourceId = '77') => ({
  params: Promise.resolve({ id, resourceId })
})

beforeEach(() => {
  vi.resetAllMocks()
  kunGetPatchPageDataActionsMock.mockResolvedValue(PAGE_DATA)
  kunGetResourceDetailActionsMock.mockResolvedValue(detailOf(PATCH_ID))
  patchMetadataMock.mockReturnValue({ title: '鲲' })
  resourceMetadataMock.mockReturnValue({ title: 'kun 补丁' })
})

describe('app/[id]/page: 作品不存在', () => {
  it('读取器的 notFound 原样穿过页面, 不记浏览量', async () => {
    kunGetPatchPageDataActionsMock.mockRejectedValue(notFoundError())

    await expect(PatchPage(patchProps())).rejects.toMatchObject(NOT_FOUND)
    expect(afterMock).not.toHaveBeenCalled()
  })

  it('读取器的 notFound 原样穿过 generateMetadata, 不落回根布局的可索引默认值', async () => {
    kunGetPatchPageDataActionsMock.mockRejectedValue(notFoundError())

    await expect(generatePatchMetadata(patchProps())).rejects.toMatchObject(
      NOT_FOUND
    )
    expect(patchMetadataMock).not.toHaveBeenCalled()
  })

  it('id 形状不对时页面直接 notFound, 不调读取器', async () => {
    await expect(PatchPage(patchProps('abc'))).rejects.toMatchObject(NOT_FOUND)
    expect(kunGetPatchPageDataActionsMock).not.toHaveBeenCalled()
  })

  it('作品存在时照常渲染并登记一次浏览量', async () => {
    await expect(PatchPage(patchProps())).resolves.toBeTruthy()
    expect(afterMock).toHaveBeenCalledTimes(1)
    await expect(generatePatchMetadata(patchProps())).resolves.toEqual({
      title: '鲲'
    })
  })
})

describe('app/[id]/resource/[resourceId]/page: 资源不存在', () => {
  it('读取器的 notFound 原样穿过页面与 generateMetadata', async () => {
    kunGetResourceDetailActionsMock.mockRejectedValue(notFoundError())

    await expect(ResourcePage(resourceProps())).rejects.toMatchObject(NOT_FOUND)
    await expect(
      generateResourceMetadata(resourceProps())
    ).rejects.toMatchObject(NOT_FOUND)
    expect(resourceMetadataMock).not.toHaveBeenCalled()
  })

  it('资源属于别的作品时页面 notFound, metadata 不泄露它的标题', async () => {
    kunGetResourceDetailActionsMock.mockResolvedValue(detailOf('zzzz9999'))

    await expect(ResourcePage(resourceProps())).rejects.toMatchObject(NOT_FOUND)
    await expect(generateResourceMetadata(resourceProps())).resolves.toEqual({})
    expect(resourceMetadataMock).not.toHaveBeenCalled()
  })

  it('资源存在且属于该作品时照常渲染', async () => {
    await expect(ResourcePage(resourceProps())).resolves.toBeTruthy()
    await expect(generateResourceMetadata(resourceProps())).resolves.toEqual({
      title: 'kun 补丁'
    })
  })
})
