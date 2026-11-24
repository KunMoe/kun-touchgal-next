import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getPatchResourceDetailMock, verifyHeaderCookieMock } = vi.hoisted(
  () => ({
    getPatchResourceDetailMock: vi.fn(),
    verifyHeaderCookieMock: vi.fn()
  })
)

// 请求级缓存换成直通, 用例之间不共享结果
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <T>(fn: T) => fn
}))

vi.mock('~/utils/actions/verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/app/api/patch/resource/detail', () => ({
  getPatchResourceDetail: getPatchResourceDetailMock
}))

import { kunGetResourceDetailActions } from '../actions'

// next/navigation 的 notFound() 抛出的错误 (文档写明的 digest), 这里用真实实现
const NOT_FOUND = { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }
const PAYLOAD = { uid: 7, name: 'kun', role: 1 }
const DETAIL = { resource: { id: 77, uniqueId: 'abcd1234' } }

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue(PAYLOAD)
  getPatchResourceDetailMock.mockResolvedValue(DETAIL)
})

describe('kunGetResourceDetailActions', () => {
  it('资源存在时以当前会话读取并原样返回', async () => {
    await expect(kunGetResourceDetailActions(77)).resolves.toBe(DETAIL)
    expect(getPatchResourceDetailMock).toHaveBeenCalledWith(77, PAYLOAD)
  })

  // 隐藏 / 待审核的资源对无权查看的人与不存在不可区分, 服务同样返回 null
  it('资源不存在或对当前视角不可见时以 notFound 结束', async () => {
    getPatchResourceDetailMock.mockResolvedValue(null)

    await expect(kunGetResourceDetailActions(77)).rejects.toMatchObject(
      NOT_FOUND
    )
  })

  it.each([0, Number.NaN, 1.5, 2147483648])(
    'id 越界 (%s) 时以 notFound 结束, 不读会话不查库',
    async (resourceId) => {
      await expect(
        kunGetResourceDetailActions(resourceId)
      ).rejects.toMatchObject(NOT_FOUND)
      expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
      expect(getPatchResourceDetailMock).not.toHaveBeenCalled()
    }
  )
})
