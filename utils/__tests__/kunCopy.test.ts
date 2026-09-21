import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('react-hot-toast', () => ({
  default: { success: toastSuccessMock, error: toastErrorMock }
}))

import { kunCopy } from '~/utils/kunCopy'

describe('kunCopy', () => {
  const writeTextMock = vi.fn()

  beforeEach(() => {
    vi.resetAllMocks()
    writeTextMock.mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText: writeTextMock } })
  })

  // 提取码 / 解压码是发布者的任意输入, 含 %40 这类合法转义序列时也必须原样复制,
  // 不能被 decodeURIComponent 改写成 abc@def
  it('copies text containing percent-escape sequences verbatim', async () => {
    kunCopy('abc%40def')

    expect(writeTextMock).toHaveBeenCalledWith('abc%40def')
    await vi.waitFor(() => expect(toastSuccessMock).toHaveBeenCalled())
    expect(toastSuccessMock.mock.calls[0][0]).toMatch(/^abc%40def /)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })
})
