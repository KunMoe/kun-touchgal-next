import { describe, expect, it } from 'vitest'
import {
  DependencyFailure,
  classifyAwsSdkError,
  classifyHttpStatus,
  classifyTransportError,
  parseRetryAfterMs,
  toDependencyFailure
} from '~/lib/resilience/failure'

describe('classifyHttpStatus', () => {
  it.each([
    [401, 'misconfigured'],
    [403, 'misconfigured'],
    [404, 'misconfigured'],
    [429, 'rate_limited'],
    [408, 'transient'],
    [425, 'transient'],
    [500, 'transient'],
    [502, 'transient'],
    [503, 'transient'],
    [504, 'transient'],
    [524, 'transient'],
    [400, 'request'],
    [413, 'request'],
    [422, 'request'],
    [409, 'request'],
    // 认不出的状态码算在请求头上
    [304, 'request'],
    [418, 'request']
  ] as const)('%i → %s', (status, scope) => {
    expect(classifyHttpStatus(status)).toBe(scope)
  })
})

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-11-20T12:00:00.000Z')

  it('秒数', () => {
    expect(parseRetryAfterMs('120', now)).toBe(120_000)
    expect(parseRetryAfterMs(' 0 ', now)).toBe(0)
  })

  it('HTTP-date: 取与当前时刻的差, 已过去的时刻为 0', () => {
    expect(parseRetryAfterMs('Fri, 20 Nov 2026 12:01:30 GMT', now)).toBe(90_000)
    expect(parseRetryAfterMs('Fri, 20 Nov 2026 11:00:00 GMT', now)).toBe(0)
  })

  it.each([
    [null],
    [''],
    ['soon'],
    ['-5'],
    ['1.5'],
    // Date.parse 会把这些猜成某个时刻
    ['2026-11-20T12:01:30Z'],
    ['Nov 20 2026'],
    ['Fri, 20 Nov 2026 12:01:30 +0800']
  ])('%j 当作没给', (value) => {
    expect(parseRetryAfterMs(value, now)).toBeNull()
  })
})

// 错误形状取自 Node 26 的 fetch 与 @smithy/node-http-handler 的实际产出
// (server/moderation/__tests__/provider-failures.e2e.test.ts 用真实的 fetch 再钉一遍)
describe('classifyTransportError', () => {
  it.each([
    [
      'AbortSignal.timeout 触发',
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError'
      )
    ],
    ['AbortController 中止', new DOMException('aborted', 'AbortError')],
    [
      'AWS SDK 的中止',
      Object.assign(new Error('Request aborted'), { name: 'AbortError' })
    ],
    [
      'AWS SDK 的套接字超时',
      Object.assign(new Error('socket timed out'), { name: 'TimeoutError' })
    ],
    [
      'fetch 连不上',
      new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    ],
    [
      'fetch 读流时连接断开',
      new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } })
    ],
    [
      'node handler 的系统错误',
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    ],
    [
      'DNS 解析失败',
      new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
    ]
  ])('%s → transient', (_name, error) => {
    expect(classifyTransportError(error)).toBe('transient')
  })

  it.each([
    ['代码自己的 TypeError', new TypeError('x is not a function')],
    ['普通错误', new Error('boom')],
    [
      '不是网络问题的 undici 错误码',
      new TypeError('fetch failed', { cause: { code: 'UND_ERR_INVALID_ARG' } })
    ],
    ['不是 Error', 'boom'],
    ['null', null]
  ])('%s → 认不出', (_name, error) => {
    expect(classifyTransportError(error)).toBeNull()
  })
})

describe('classifyAwsSdkError', () => {
  const serviceError = (
    fault: 'client' | 'server' | undefined,
    httpStatusCode: number | undefined
  ) =>
    Object.assign(new Error('aws'), {
      ...(fault ? { $fault: fault } : {}),
      $metadata: { httpStatusCode, attempts: 1 }
    })

  it.each([
    ['AccessDenied', serviceError('client', 403), 'misconfigured'],
    ['InvalidAccessKeyId', serviceError('client', 401), 'misconfigured'],
    ['SlowDown', serviceError('server', 503), 'transient'],
    ['InternalError', serviceError('server', 500), 'transient'],
    ['TooManyRequests', serviceError('client', 429), 'rate_limited'],
    ['InvalidRequest', serviceError('client', 400), 'request'],
    // 对象不存在是这一次请求指名的对象的问题
    ['NoSuchKey', serviceError('client', 404), 'request'],
    ['没带状态码的服务端故障', serviceError('server', undefined), 'transient'],
    ['没带状态码的客户端故障', serviceError('client', undefined), 'request']
  ] as const)('%s → %s', (_name, error, scope) => {
    expect(classifyAwsSdkError(error)).toBe(scope)
  })

  it('重试中间件只挂了 $metadata 的网络错误交给传输层判断', () => {
    const error = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
      $metadata: { attempts: 3, totalRetryDelay: 120 }
    })

    expect(classifyAwsSdkError(error)).toBeNull()
    expect(classifyTransportError(error)).toBe('transient')
  })

  it('不是 SDK 的错误认不出', () => {
    expect(classifyAwsSdkError(new Error('boom'))).toBeNull()
    expect(classifyAwsSdkError(null)).toBeNull()
  })
})

describe('toDependencyFailure', () => {
  it('认得出的错误翻成 DependencyFailure, 原错误留在 cause 里', () => {
    const cause = new TypeError('fetch failed', {
      cause: { code: 'ECONNREFUSED' }
    })

    const failure = toDependencyFailure('moderation_ai', cause)

    expect(failure).toBeInstanceOf(DependencyFailure)
    expect(failure).toMatchObject({
      dependency: 'moderation_ai',
      scope: 'transient',
      status: null,
      retryAfterMs: null,
      message: 'fetch failed (ECONNREFUSED)',
      cause
    })
  })

  it('SDK 的服务异常带上状态码', () => {
    const cause = Object.assign(new Error('Access Denied'), {
      $fault: 'client',
      $metadata: { httpStatusCode: 403 }
    })

    expect(toDependencyFailure('s3', cause)).toMatchObject({
      dependency: 's3',
      scope: 'misconfigured',
      status: 403,
      message: 'Access Denied'
    })
  })

  it('认不出的错误原样返回', () => {
    const error = new Error('Empty S3 object body for key: a')

    expect(toDependencyFailure('s3', error)).toBe(error)
    expect(toDependencyFailure('s3', 'boom')).toBe('boom')
  })

  it('已经是 DependencyFailure 的不再包一层', () => {
    const failure = new DependencyFailure({
      dependency: 'moderation_ai',
      scope: 'rate_limited',
      message: '429',
      status: 429,
      retryAfterMs: 5_000
    })

    expect(toDependencyFailure('s3', failure)).toBe(failure)
  })
})
