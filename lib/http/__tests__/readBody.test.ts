import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import {
  KunBodyLimitError,
  kunBodyFailureMessage,
  kunBodyFormData,
  kunBodyJson,
  kunReadBody,
  parseContentLength
} from '../readBody'
import { KUN_BODY_BUDGET } from '~/constants/bodyBudget'
import type { KunBodyFailure } from '../readBody'

// multipart 夹具一律先序列化成字节再用: 以 FormData 为源的 Request 被 cancel 之后, undici 会
// 异步抛出未捕获的 ERR_INVALID_STATE, 打崩 vitest worker

const URL_ = 'http://localhost/api/test'
const bytesOf = (size: number, fill = 0x61) => new Uint8Array(size).fill(fill)

// 只有 kunReadBody 用到的三样: headers、body、url。用来造真实 Request 造不出来的流
const fakeRequest = (
  body: ReadableStream<Uint8Array> | null,
  headers: Record<string, string> = {}
) => ({ url: URL_, headers: new Headers(headers), body }) as unknown as Request

const streamOf = (chunks: Uint8Array[], onCancel?: () => void) =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift()
      if (next) {
        controller.enqueue(next)
      } else {
        controller.close()
      }
    },
    cancel() {
      onCancel?.()
    }
  })

beforeEach(() => {
  vi.mocked(kunLog).mockClear()
})

describe('parseContentLength', () => {
  it.each([
    ['12', 12],
    [' 12 ', 12],
    ['0', 0]
  ])('%j 是 %d', (header, expected) => {
    expect(parseContentLength(header)).toBe(expected)
  })

  it.each([null, '', '  ', '-1', 'abc', '1e3', '1.5', '0x10', '12, 12'])(
    '%j 当作没有声明 (null), 不当成 0',
    (header) => {
      expect(parseContentLength(header)).toBeNull()
    }
  )
})

describe('kunReadBody', () => {
  it('Content-Length 超过预算时一个字节都不读', async () => {
    const req = new Request(URL_, {
      method: 'POST',
      body: bytesOf(101),
      headers: { 'content-length': '101' }
    })

    const result = await kunReadBody(req, 100)

    expect(result).toEqual({
      ok: false,
      reason: 'too-large',
      maxBytes: 100,
      received: 0,
      declared: 101
    })
    expect(req.bodyUsed).toBe(false)
  })

  it('没有 Content-Length 的流读到超出预算即取消, 不再往下读', async () => {
    const cancel = vi.fn()
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        controller.enqueue(bytesOf(40))
      },
      cancel
    })

    const result = await kunReadBody(fakeRequest(endless), 100)

    expect(result).toMatchObject({
      ok: false,
      reason: 'too-large',
      received: 120,
      declared: null
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    // 读第 3 块越界; 可读流最多预取一块
    expect(pulled).toBeLessThanOrEqual(4)
  })

  it('恰好等于预算时通过, 字节按顺序拼接', async () => {
    const req = fakeRequest(streamOf([bytesOf(60, 1), bytesOf(40, 2)]), {
      'content-length': '100'
    })

    const result = await kunReadBody(req, 100)

    expect(result.ok).toBe(true)
    const { bytes } = result as { bytes: Uint8Array }
    expect(bytes.byteLength).toBe(100)
    expect(bytes[59]).toBe(1)
    expect(bytes[60]).toBe(2)
  })

  it('没有 Content-Length 时照常读完', async () => {
    const result = await kunReadBody(fakeRequest(streamOf([bytesOf(10)])), 100)

    expect(result).toMatchObject({ ok: true })
    expect((result as { bytes: Uint8Array }).bytes.byteLength).toBe(10)
  })

  it('读完比 Content-Length 声明的少: proxy 克隆截断, 判为 truncated', async () => {
    const req = fakeRequest(streamOf([bytesOf(50)]), { 'content-length': '80' })

    expect(await kunReadBody(req, 100)).toEqual({
      ok: false,
      reason: 'truncated',
      maxBytes: 100,
      received: 50,
      declared: 80
    })
  })

  it('读的过程中流出错判为 aborted', async () => {
    let sent = false
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error('socket hang up'))
          return
        }
        sent = true
        controller.enqueue(bytesOf(10))
      }
    })

    expect(await kunReadBody(fakeRequest(broken), 100)).toMatchObject({
      ok: false,
      reason: 'aborted',
      received: 10
    })
  })

  it('没有请求体时返回空字节', async () => {
    const result = await kunReadBody(new Request(URL_), 100)

    expect(result).toEqual({ ok: true, bytes: new Uint8Array(0) })
    expect(kunLog).not.toHaveBeenCalled()
  })

  it('每次拒绝记一行 warn, 带路径与计数', async () => {
    await kunReadBody(fakeRequest(null, { 'content-length': '500' }), 100)

    expect(kunLog).toHaveBeenCalledTimes(1)
    expect(kunLog).toHaveBeenCalledWith('body.rejected', {
      path: '/api/test',
      reason: 'too-large',
      maxBytes: 100,
      declared: 500,
      received: 0
    })
  })
})

describe('kunBodyFailureMessage', () => {
  const failure = (
    reason: KunBodyFailure['reason'],
    maxBytes: number
  ): KunBodyFailure => ({
    ok: false,
    reason,
    maxBytes,
    received: 0,
    declared: null
  })

  it.each([
    [KUN_BODY_BUDGET.tiny, '请求内容超过 16 KB, 请缩小后重试'],
    [KUN_BODY_BUDGET.json, '请求内容超过 1 MB, 请缩小后重试'],
    [KUN_BODY_BUDGET.jsonLarge, '请求内容超过 2 MB, 请缩小后重试'],
    // 图片入口的预算大于 proxy 克隆上限: 按较小的那个说, 不说一个达不到的数
    [KUN_BODY_BUDGET.image, '请求内容超过 10 MB, 请缩小后重试'],
    [KUN_BODY_BUDGET.imagePair, '请求内容超过 10 MB, 请缩小后重试']
  ])('超过 %d 字节的预算', (maxBytes, message) => {
    expect(kunBodyFailureMessage(failure('too-large', maxBytes))).toBe(message)
  })

  it('截断的文案按 proxy 克隆上限说', () => {
    expect(
      kunBodyFailureMessage(failure('truncated', KUN_BODY_BUDGET.imagePair))
    ).toBe('请求内容超过 10 MB, 请缩小后重试')
  })

  it('读失败', () => {
    expect(kunBodyFailureMessage(failure('aborted', 100))).toBe(
      '请求内容没有完整送达, 请重试'
    )
  })
})

describe('KunBodyLimitError', () => {
  it('带着失败原样抛出', () => {
    const detail = {
      ok: false,
      reason: 'too-large',
      maxBytes: 1,
      received: 0,
      declared: 2
    } as const
    const error = new KunBodyLimitError(detail)

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('KunBodyLimitError')
    expect(error.failure).toBe(detail)
  })
})

describe('kunBodyJson', () => {
  const encode = (text: string) =>
    new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>

  it('与 Body.json() 一样按 UTF-8 解码并去掉 BOM', () => {
    expect(kunBodyJson(encode('\uFEFF{"name":"中文"}'))).toEqual({
      name: '中文'
    })
  })

  it.each(['', 'not json', '{"a":'])('%j 解析失败是 null', (text) => {
    expect(kunBodyJson(encode(text))).toBeNull()
  })
})

describe('kunBodyFormData', () => {
  const serialize = async (form: FormData) => {
    const response = new Response(form)
    return {
      contentType: response.headers.get('content-type'),
      bytes: new Uint8Array(await response.arrayBuffer())
    }
  }

  const form = () => {
    const value = new FormData()
    value.append('image', new Blob([bytesOf(1000)]), 'a.png')
    value.append('name', '封面')
    return value
  }

  it('完整的 multipart 解析出文件与字段', async () => {
    const { contentType, bytes } = await serialize(form())

    const parsed = await kunBodyFormData(bytes, contentType)

    expect((parsed?.get('image') as File).size).toBe(1000)
    expect(parsed?.get('name')).toBe('封面')
  })

  it('缺了结尾 boundary 的 multipart (没有 Content-Length 时的截断) 是 null', async () => {
    const { contentType, bytes } = await serialize(form())

    expect(await kunBodyFormData(bytes.slice(0, 600), contentType)).toBeNull()
  })

  it('urlencoded 表单', async () => {
    const bytes = new TextEncoder().encode(
      'token=abc'
    ) as Uint8Array<ArrayBuffer>

    const parsed = await kunBodyFormData(
      bytes,
      'application/x-www-form-urlencoded'
    )

    expect(parsed?.get('token')).toBe('abc')
  })

  it('没有 Content-Type 是 null', async () => {
    expect(await kunBodyFormData(bytesOf(10), null)).toBeNull()
  })
})
