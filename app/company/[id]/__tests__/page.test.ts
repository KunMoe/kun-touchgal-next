import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kunGetCompanyByIdActionsMock,
  kunGetCompanyPageDataActionsMock,
  metadataMock
} = vi.hoisted(() => ({
  kunGetCompanyByIdActionsMock: vi.fn(),
  kunGetCompanyPageDataActionsMock: vi.fn(),
  metadataMock: vi.fn()
}))

vi.mock('~/app/company/[id]/actions', () => ({
  kunGetCompanyByIdActions: kunGetCompanyByIdActionsMock,
  kunGetCompanyPageDataActions: kunGetCompanyPageDataActionsMock
}))
vi.mock('~/app/company/[id]/metadata', () => ({
  generateKunMetadataTemplate: metadataMock
}))

// 子组件只作为元素类型出现, 不渲染; 替换掉以免拉进整套客户端组件
vi.mock('~/components/company/detail/Container', () => ({
  CompanyDetailContainer: vi.fn(() => null)
}))
vi.mock('~/components/error/ErrorComponent', () => ({
  ErrorComponent: vi.fn(() => null)
}))
vi.mock('~/components/kun/BreadcrumbTitle', () => ({
  KunBreadcrumbTitle: vi.fn(() => null)
}))

import CompanyPage, { generateMetadata } from '~/app/company/[id]/page'
import { ErrorComponent } from '~/components/error/ErrorComponent'

// next/navigation 的 notFound() 抛出的错误 (文档写明的 digest); 读取器被 mock 掉,
// 用同样形状的错误代替它在「不存在」时抛出的那一个
const NOT_FOUND = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }
const notFoundError = () =>
  Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), NOT_FOUND)

const COMPANY = { id: 8, name: 'Key' }
const props = (id = '8') => ({
  params: Promise.resolve({ id }),
  searchParams: Promise.resolve({})
})

beforeEach(() => {
  vi.resetAllMocks()
  kunGetCompanyByIdActionsMock.mockResolvedValue(COMPANY)
  kunGetCompanyPageDataActionsMock.mockResolvedValue({
    company: COMPANY,
    response: { galgames: [], total: 0 }
  })
  metadataMock.mockReturnValue({ title: 'Key' })
})

describe('app/company/[id]/page: 会社不存在', () => {
  it('读取器的 notFound 原样穿过页面', async () => {
    kunGetCompanyPageDataActionsMock.mockRejectedValue(notFoundError())

    await expect(CompanyPage(props())).rejects.toMatchObject(NOT_FOUND)
  })

  it('读取器的 notFound 原样穿过 generateMetadata, 不落回根布局的可索引默认值', async () => {
    kunGetCompanyByIdActionsMock.mockRejectedValue(notFoundError())

    await expect(generateMetadata(props())).rejects.toMatchObject(NOT_FOUND)
    expect(metadataMock).not.toHaveBeenCalled()
  })

  it('会社存在时 generateMetadata 用它生成 metadata', async () => {
    await expect(generateMetadata(props())).resolves.toEqual({ title: 'Key' })
    expect(kunGetCompanyByIdActionsMock).toHaveBeenCalledWith({ companyId: 8 })
    expect(metadataMock).toHaveBeenCalledWith(COMPANY)
  })

  // 「不存在」之外的失败 (查询串校验、作品列表查询) 仍是字符串, 照旧渲染错误卡
  it('读取器返回字符串时渲染错误卡', async () => {
    kunGetCompanyPageDataActionsMock.mockResolvedValue('作品查询失败')

    const element = (await CompanyPage(props())) as {
      type: unknown
      props: Record<string, unknown>
    }

    expect(element.type).toBe(ErrorComponent)
    expect(element.props).toEqual({ error: '作品查询失败' })
  })
})
