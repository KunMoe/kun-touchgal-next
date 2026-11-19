import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPatchPageDataMock, verifyHeaderCookieMock } = vi.hoisted(() => ({
  getPatchPageDataMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn()
}))

// 请求级缓存换成直通, 用例之间不共享结果
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <T>(fn: T) => fn
}))

vi.mock('~/utils/actions/verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/api/patch/pageData', () => ({
  getPatchPageData: getPatchPageDataMock
}))

vi.mock('~/app/api/patch/views/put', () => ({
  updatePatchViews: vi.fn()
}))

import { kunGetPatchPageDataActions } from '../actions'

// next/navigation 的 notFound() 抛出的错误 (文档写明的 digest), 这里用真实实现
const NOT_FOUND = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }
const PAYLOAD = { uid: 7, name: 'kun', role: 1 }
const PAGE_DATA = { patch: { id: 1, uniqueId: 'abcd1234' }, intro: {} }

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(PAYLOAD)
  getPatchPageDataMock.mockResolvedValue(PAGE_DATA)
})

describe('kunGetPatchPageDataActions', () => {
  it('作品存在时以当前会话读取并原样返回', async () => {
    await expect(kunGetPatchPageDataActions('abcd1234')).resolves.toBe(
      PAGE_DATA
    )
    expect(getPatchPageDataMock).toHaveBeenCalledWith(
      { uniqueId: 'abcd1234' },
      PAYLOAD
    )
  })

  it('作品不存在时以 notFound 结束', async () => {
    getPatchPageDataMock.mockResolvedValue(null)

    await expect(kunGetPatchPageDataActions('abcd1234')).rejects.toMatchObject(
      NOT_FOUND
    )
  })

  it.each(['abc', 'abcd12345'])(
    'id 形状不对 (%s) 时以 notFound 结束, 不读会话不查库',
    async (uniqueId) => {
      await expect(kunGetPatchPageDataActions(uniqueId)).rejects.toMatchObject(
        NOT_FOUND
      )
      expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
      expect(getPatchPageDataMock).not.toHaveBeenCalled()
    }
  )
})
