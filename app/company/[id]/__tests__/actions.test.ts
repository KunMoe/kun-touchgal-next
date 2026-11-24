import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GALGAME_FILTER_VALUE,
  DEFAULT_GALGAME_MONTH_STRING,
  DEFAULT_GALGAME_SORT_FIELD,
  DEFAULT_GALGAME_SORT_ORDER,
  DEFAULT_GALGAME_YEAR_STRING
} from '~/utils/galgameFilter'

const {
  getCompanyByIdMock,
  getPatchByCompanyMock,
  listViewMock,
  reactCacheEntriesMock
} = vi.hoisted(() => ({
  getCompanyByIdMock: vi.fn(),
  getPatchByCompanyMock: vi.fn(),
  listViewMock: vi.fn(),
  reactCacheEntriesMock: [] as Array<{
    fn: unknown
    args: unknown[]
    result: unknown
  }>
}))

vi.mock('react', () => ({
  cache: <Args extends unknown[], Result>(fn: (...args: Args) => Result) => {
    return (...args: Args): Result => {
      const cached = reactCacheEntriesMock.find(
        (entry) =>
          Object.is(entry.fn, fn) &&
          entry.args.length === args.length &&
          entry.args.every((argument, index) =>
            Object.is(argument, args[index])
          )
      )
      if (cached) {
        return cached.result as Result
      }

      const result = fn(...args)
      reactCacheEntriesMock.push({ fn, args, result })
      return result
    }
  }
}))

vi.mock('~/app/api/company/service', () => ({
  getCompanyById: getCompanyByIdMock
}))

vi.mock('~/app/api/company/galgame/service', () => ({
  getPatchByCompany: getPatchByCompanyMock
}))

vi.mock('~/server/viewer/fromHeaders', () => ({
  getViewerContext: async () => ({ listView: listViewMock })
}))

import {
  kunGetCompanyByIdActions,
  kunGetCompanyPageDataActions
} from '../actions'

const VIEW = {
  kind: 'shared',
  visibility: { contentLimit: 'sfw', blockedTagIds: [] }
}

// next/navigation 的 notFound() 抛出的错误 (文档写明的 digest), 这里用真实实现
const NOT_FOUND = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }

beforeEach(() => {
  vi.clearAllMocks()
  reactCacheEntriesMock.length = 0
  listViewMock.mockResolvedValue(VIEW)
})

const patchParams = {
  page: 1,
  limit: 24,
  selectedType: DEFAULT_GALGAME_FILTER_VALUE,
  selectedLanguage: DEFAULT_GALGAME_FILTER_VALUE,
  selectedPlatform: DEFAULT_GALGAME_FILTER_VALUE,
  sortField: DEFAULT_GALGAME_SORT_FIELD,
  sortOrder: DEFAULT_GALGAME_SORT_ORDER,
  yearString: DEFAULT_GALGAME_YEAR_STRING,
  monthString: DEFAULT_GALGAME_MONTH_STRING,
  minRatingCount: 0
}

describe('kunGetCompanyByIdActions', () => {
  it('deduplicates in-flight company lookups with the page data action', async () => {
    let resolveCompany:
      ((value: { id: number; name: string }) => void) | undefined
    const pendingCompany = new Promise<{ id: number; name: string }>(
      (resolve) => {
        resolveCompany = resolve
      }
    )
    const company = { id: 14, name: '缓存会社' }
    const response = { galgames: [], total: 0 }
    getCompanyByIdMock.mockReturnValue(pendingCompany)
    getPatchByCompanyMock.mockResolvedValue(response)

    const metadataPromise = kunGetCompanyByIdActions({
      companyId: company.id
    })
    const pageDataPromise = kunGetCompanyPageDataActions({
      ...patchParams,
      companyId: company.id
    })

    await vi.waitFor(() => {
      expect(getCompanyByIdMock).toHaveBeenCalledTimes(1)
      expect(getPatchByCompanyMock).toHaveBeenCalledTimes(1)
    })

    resolveCompany?.(company)
    await expect(
      Promise.all([metadataPromise, pageDataPromise])
    ).resolves.toEqual([company, { company, response }])
  })

  it('answers a missing company with notFound', async () => {
    getCompanyByIdMock.mockResolvedValue(null)

    await expect(
      kunGetCompanyByIdActions({ companyId: 15 })
    ).rejects.toMatchObject(NOT_FOUND)
  })

  it.each([0, Number.NaN, 1.5, 2147483648])(
    'answers an invalid company id (%s) with notFound without querying',
    async (companyId) => {
      await expect(
        kunGetCompanyByIdActions({ companyId })
      ).rejects.toMatchObject(NOT_FOUND)
      expect(getCompanyByIdMock).not.toHaveBeenCalled()
    }
  )
})

describe('kunGetCompanyPageDataActions', () => {
  it('starts the patch query before the company query settles', async () => {
    let resolveCompany:
      ((value: { id: number; name: string }) => void) | undefined
    const pendingCompany = new Promise<{ id: number; name: string }>(
      (resolve) => {
        resolveCompany = resolve
      }
    )
    const company = { id: 8, name: '并行会社' }
    const response = { galgames: [], total: 0 }
    getCompanyByIdMock.mockReturnValue(pendingCompany)
    getPatchByCompanyMock.mockResolvedValue(response)

    const pageDataPromise = kunGetCompanyPageDataActions({
      ...patchParams,
      companyId: company.id
    })

    await vi.waitFor(() => {
      expect(getPatchByCompanyMock).toHaveBeenCalledTimes(1)
    })

    resolveCompany?.(company)
    await expect(pageDataPromise).resolves.toEqual({ company, response })
  })

  it('keeps a missing company ahead of patch errors', async () => {
    getCompanyByIdMock.mockResolvedValue(null)
    getPatchByCompanyMock.mockResolvedValue('作品查询失败')

    await expect(
      kunGetCompanyPageDataActions({ ...patchParams, companyId: 9 })
    ).rejects.toMatchObject(NOT_FOUND)
  })

  it('answers a missing company with notFound without waiting for the patch query', async () => {
    getCompanyByIdMock.mockResolvedValue(null)
    getPatchByCompanyMock.mockReturnValue(new Promise(() => undefined))

    await expect(
      kunGetCompanyPageDataActions({ ...patchParams, companyId: 13 })
    ).rejects.toMatchObject(NOT_FOUND)
  })

  it.each([0, Number.NaN, 1.5, 2147483648])(
    'answers an invalid company id (%s) with notFound without querying',
    async (companyId) => {
      await expect(
        kunGetCompanyPageDataActions({ ...patchParams, companyId })
      ).rejects.toMatchObject(NOT_FOUND)
      expect(getCompanyByIdMock).not.toHaveBeenCalled()
      expect(getPatchByCompanyMock).not.toHaveBeenCalled()
    }
  )

  // 路由段参数之外的校验失败 (查询串) 仍是普通的字符串失败, 不是 404
  it('returns the validation message for a bad query param on an existing company', async () => {
    getCompanyByIdMock.mockResolvedValue({ id: 16, name: '测试会社' })

    const result = await kunGetCompanyPageDataActions({
      ...patchParams,
      companyId: 16,
      limit: 0
    })

    expect(typeof result).toBe('string')
    expect(getPatchByCompanyMock).not.toHaveBeenCalled()
  })

  // 页面与 generateMetadata 必须对「不存在」给出同一个结论, 与查询串无关
  it('answers a missing company with notFound even when the query param is bad', async () => {
    getCompanyByIdMock.mockResolvedValue(null)

    await expect(
      kunGetCompanyPageDataActions({ ...patchParams, companyId: 17, limit: 0 })
    ).rejects.toMatchObject(NOT_FOUND)
    expect(getPatchByCompanyMock).not.toHaveBeenCalled()
  })

  it('returns the patch error after a successful company lookup', async () => {
    getCompanyByIdMock.mockResolvedValue({ id: 10, name: '测试会社' })
    getPatchByCompanyMock.mockResolvedValue('作品查询失败')

    await expect(
      kunGetCompanyPageDataActions({ ...patchParams, companyId: 10 })
    ).resolves.toBe('作品查询失败')
  })

  it('keeps notFound for a missing company when the concurrent patch query rejects', async () => {
    let resolveCompany: ((value: null) => void) | undefined
    const pendingCompany = new Promise<null>((resolve) => {
      resolveCompany = resolve
    })
    getCompanyByIdMock.mockReturnValue(pendingCompany)
    getPatchByCompanyMock.mockRejectedValue(new Error('数据库不可用'))

    const pageDataPromise = kunGetCompanyPageDataActions({
      ...patchParams,
      companyId: 11
    })
    await vi.waitFor(() => {
      expect(getPatchByCompanyMock).toHaveBeenCalledTimes(1)
    })

    resolveCompany?.(null)
    await expect(pageDataPromise).rejects.toMatchObject(NOT_FOUND)
  })

  it('rethrows a patch failure after a successful company lookup', async () => {
    const error = new Error('数据库不可用')
    getCompanyByIdMock.mockResolvedValue({ id: 12, name: '测试会社' })
    getPatchByCompanyMock.mockRejectedValue(error)

    await expect(
      kunGetCompanyPageDataActions({ ...patchParams, companyId: 12 })
    ).rejects.toBe(error)
  })
})
