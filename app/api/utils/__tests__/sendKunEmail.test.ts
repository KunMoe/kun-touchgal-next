import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import { sendKunEmail } from '~/app/api/utils/sendKunEmail'

const SEND_EMAIL_ERROR = '邮件发送失败, 请稍后重试'

const payload = {
  to: ['test@example.com'],
  subject: '测试邮件',
  tag: 'test-tag',
  html_body: '<p>html</p>',
  plain_body: 'plain'
}

const upstreamErrorBody =
  '{"status":"error","data":{"code":"InvalidServerAPIKey"}}'

describe('sendKunEmail', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(kunLog).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })

  it('returns undefined on success', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success' })
    })

    const result = await sendKunEmail(payload)

    expect(result).toBeUndefined()
    expect(kunLog).not.toHaveBeenCalled()
  })

  it('passes a timeout signal to fetch', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'success' })
    })

    await sendKunEmail(payload)

    const [, init] = fetchMock.mock.calls[0]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  // 中继的原始响应体可能带收件地址: 只释放, 不读也不记
  it('returns a fixed message and logs when the response is not ok', async () => {
    const cancel = vi.fn(async () => undefined)
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      body: { cancel },
      text: async () => upstreamErrorBody
    })

    const result = await sendKunEmail(payload)

    expect(result).toBe(SEND_EMAIL_ERROR)
    expect(result).not.toContain('InvalidServerAPIKey')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(kunLog).toHaveBeenCalledTimes(1)
    expect(kunLog).toHaveBeenCalledWith('email.send_failed', {
      tag: 'test-tag',
      status: 401
    })
  })

  it('returns a fixed message and logs when the relay reports an error status', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'error', data: { code: 'NoRecipients' } })
    })

    const result = await sendKunEmail(payload)

    expect(result).toBe(SEND_EMAIL_ERROR)
    expect(result).not.toContain('NoRecipients')
    expect(kunLog).toHaveBeenCalledWith('email.send_failed', {
      tag: 'test-tag',
      relayStatus: 'error',
      relayCode: 'NoRecipients'
    })
  })

  it('logs only a string relay code, never the relay message', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'error',
        data: { code: 42, message: 'test@example.com rejected' }
      })
    })

    const result = await sendKunEmail(payload)

    expect(result).toBe(SEND_EMAIL_ERROR)
    expect(kunLog).toHaveBeenCalledTimes(1)
    expect(vi.mocked(kunLog).mock.calls[0]).toEqual([
      'email.send_failed',
      { tag: 'test-tag', relayStatus: 'error', relayCode: undefined }
    ])
    expect(JSON.stringify(vi.mocked(kunLog).mock.calls[0])).not.toContain(
      'test@example.com'
    )
  })

  it('returns a fixed message and logs when fetch rejects', async () => {
    const error = new TypeError('fetch failed')
    fetchMock.mockRejectedValue(error)

    const result = await sendKunEmail(payload)

    expect(result).toBe(SEND_EMAIL_ERROR)
    expect(kunLog).toHaveBeenCalledWith(
      'email.send_failed',
      { tag: 'test-tag' },
      error
    )
  })

  it('returns a fixed message when the response body is not valid JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      }
    })

    const result = await sendKunEmail(payload)

    expect(result).toBe(SEND_EMAIL_ERROR)
    expect(kunLog).toHaveBeenCalledWith(
      'email.send_failed',
      { tag: 'test-tag' },
      expect.any(SyntaxError)
    )
  })
})
