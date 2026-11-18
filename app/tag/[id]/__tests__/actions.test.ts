import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GALGAME_FILTER_VALUE,
  DEFAULT_GALGAME_MONTH_STRING,
  DEFAULT_GALGAME_SORT_FIELD,
  DEFAULT_GALGAME_SORT_ORDER,
  DEFAULT_GALGAME_YEAR_STRING
} from '~/utils/galgameFilter'

const {
  getTagByIdMock,
  getPatchByTagMock,
  listViewMock,
  verifyHeaderCookieMock,
  reactCacheEntriesMock
} = vi.hoisted(() => ({
  getTagByIdMock: vi.fn(),
  getPatchByTagMock: vi.fn(),
  listViewMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
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

vi.mock('~/app/api/tag/get', () => ({
  getTagById: getTagByIdMock
}))

vi.mock('~/app/api/tag/galgame/service', () => ({
  getPatchByTag: getPatchByTagMock
}))

vi.mock('~/server/viewer/fromHeaders', () => ({
  getViewerContext: async () => ({ listView: listViewMock })
}))

vi.mock('~/utils/actions/verifyHeaderCookie', async () => {
  const { cache } = await import('react')

  return {
    verifyHeaderCookie: cache(verifyHeaderCookieMock)
  }
})

import { kunGetTagMetadataActions, kunGetTagPageDataActions } from '../actions'

const VIEW = {
  kind: 'shared',
  visibility: { contentLimit: 'sfw', blockedTagIds: [] },
  cacheVariant: 'sfw:'
}

beforeEach(() => {
  vi.clearAllMocks()
  reactCacheEntriesMock.length = 0
  listViewMock.mockResolvedValue(VIEW)
  verifyHeaderCookieMock.mockResolvedValue({ uid: 1 })
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

describe('kunGetTagMetadataActions', () => {
  it('shares an anonymous auth result and skips all data queries', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    const [metadataResult, pageResult] = await Promise.all([
      kunGetTagMetadataActions({ tagId: 13 }),
      kunGetTagPageDataActions({ ...patchParams, tagId: 13 })
    ])

    expect(metadataResult).toBeNull()
    expect(pageResult).toBeNull()
    expect(verifyHeaderCookieMock).toHaveBeenCalledTimes(1)
    expect(getTagByIdMock).not.toHaveBeenCalled()
    expect(listViewMock).not.toHaveBeenCalled()
    expect(getPatchByTagMock).not.toHaveBeenCalled()
  })

  it('deduplicates in-flight auth and tag lookups for logged-in users', async () => {
    let resolveAuth: ((value: { uid: number }) => void) | undefined
    let resolveTag: ((value: { id: number; name: string }) => void) | undefined
    const pendingAuth = new Promise<{ uid: number }>((resolve) => {
      resolveAuth = resolve
    })
    const pendingTag = new Promise<{ id: number; name: string }>((resolve) => {
      resolveTag = resolve
    })
    const tag = { id: 14, name: '登录标签' }
    const response = { galgames: [], total: 0 }
    verifyHeaderCookieMock.mockReturnValue(pendingAuth)
    getTagByIdMock.mockReturnValue(pendingTag)
    getPatchByTagMock.mockResolvedValue(response)

    const metadataPromise = kunGetTagMetadataActions({ tagId: tag.id })
    const pageDataPromise = kunGetTagPageDataActions({
      ...patchParams,
      tagId: tag.id
    })

    await vi.waitFor(() => {
      expect(verifyHeaderCookieMock).toHaveBeenCalledTimes(1)
    })
    resolveAuth?.({ uid: 1 })
    await vi.waitFor(() => {
      expect(getTagByIdMock).toHaveBeenCalledTimes(1)
      expect(getPatchByTagMock).toHaveBeenCalledTimes(1)
    })

    resolveTag?.(tag)
    await expect(
      Promise.all([metadataPromise, pageDataPromise])
    ).resolves.toEqual([tag, { tag, response }])
  })
})

describe('kunGetTagPageDataActions', () => {
  it('starts the patch query before the tag query settles', async () => {
    let resolveTag: ((value: { id: number; name: string }) => void) | undefined
    const pendingTag = new Promise<{ id: number; name: string }>((resolve) => {
      resolveTag = resolve
    })
    const tag = { id: 8, name: '并行标签' }
    const response = { galgames: [], total: 0 }
    getTagByIdMock.mockReturnValue(pendingTag)
    getPatchByTagMock.mockResolvedValue(response)

    const pageDataPromise = kunGetTagPageDataActions({
      ...patchParams,
      tagId: tag.id
    })

    await vi.waitFor(() => {
      expect(getPatchByTagMock).toHaveBeenCalledTimes(1)
    })

    resolveTag?.(tag)
    await expect(pageDataPromise).resolves.toEqual({ tag, response })
  })

  it('keeps tag errors ahead of patch errors', async () => {
    getTagByIdMock.mockResolvedValue('标签不存在')
    getPatchByTagMock.mockResolvedValue('作品查询失败')

    await expect(
      kunGetTagPageDataActions({ ...patchParams, tagId: 9 })
    ).resolves.toBe('标签不存在')
  })

  it('returns the patch error after a successful tag lookup', async () => {
    getTagByIdMock.mockResolvedValue({ id: 10, name: '测试标签' })
    getPatchByTagMock.mockResolvedValue('作品查询失败')

    await expect(
      kunGetTagPageDataActions({ ...patchParams, tagId: 10 })
    ).resolves.toBe('作品查询失败')
  })

  it('keeps a missing-tag error when the concurrent patch query rejects', async () => {
    let resolveTag: ((value: string) => void) | undefined
    const pendingTag = new Promise<string>((resolve) => {
      resolveTag = resolve
    })
    getTagByIdMock.mockReturnValue(pendingTag)
    getPatchByTagMock.mockRejectedValue(new Error('数据库不可用'))

    const pageDataPromise = kunGetTagPageDataActions({
      ...patchParams,
      tagId: 11
    })
    await vi.waitFor(() => {
      expect(getPatchByTagMock).toHaveBeenCalledTimes(1)
    })

    resolveTag?.('未找到标签')
    await expect(pageDataPromise).resolves.toBe('未找到标签')
  })

  it('rethrows a patch failure after a successful tag lookup', async () => {
    const error = new Error('数据库不可用')
    getTagByIdMock.mockResolvedValue({ id: 12, name: '测试标签' })
    getPatchByTagMock.mockRejectedValue(error)

    await expect(
      kunGetTagPageDataActions({ ...patchParams, tagId: 12 })
    ).rejects.toBe(error)
  })
})
