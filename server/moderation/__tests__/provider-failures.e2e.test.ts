import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DependencyFailure } from '~/lib/resilience/failure'

// provider 边界对各种失败的分类, 用真实的 fetch 打本机 HTTP 服务器: 状态码、Retry-After、
// 挂起、断流、连不上与坏输出各自落在哪个范围。分类表本身的单测在
// lib/resilience/__tests__/failure.test.ts, 这里钉的是「Node 的 fetch 实际抛出的错误
// 形状」与表对得上

// 挂起的用例不等真正的 360 秒
vi.mock(import('~/constants/moderation'), async (importOriginal) => ({
  ...(await importOriginal()),
  MODERATION_AI_TIMEOUT_MS: 200
}))

import {
  ModerationConfigError,
  moderateText as moderateTextWith
} from '~/server/moderation/ai'
import { loadModerationPolicy } from '~/server/moderation/policy'

// 与 worker 一样: 每次调用前从环境变量读出策略
const moderateText = (contentType: 'comment', userMessage: string) =>
  moderateTextWith(loadModerationPolicy(), contentType, userMessage)

const sse = (content: string, { done = true } = {}) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n` +
  (done ? 'data: [DONE]\n\n' : '')

const stream = (res: ServerResponse, body: string) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.end(body)
}

// 用户消息即场景名
const scenarios: Record<string, (res: ServerResponse) => void> = {
  '503': (res) => {
    res.writeHead(503, { 'Retry-After': '120' })
    res.end('unavailable')
  },
  '429-date': (res) => {
    res.writeHead(429, { 'Retry-After': 'Wed, 21 Oct 2099 07:28:00 GMT' })
    res.end('slow down')
  },
  '429-bare': (res) => {
    res.writeHead(429)
    res.end('slow down')
  },
  '401': (res) => {
    res.writeHead(401)
    res.end('bad key')
  },
  '404': (res) => {
    res.writeHead(404)
    res.end('no such model')
  },
  '400': (res) => {
    res.writeHead(400)
    res.end('content rejected')
  },
  '504': (res) => {
    res.writeHead(504)
    res.end('gateway timeout')
  },
  // 不回应, 等客户端超时
  hang: () => undefined,
  // 发了一半正文之后直接掐断连接
  cut: (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(sse('{"pass":', { done: false }))
    setTimeout(() => res.socket?.destroy(), 20)
  },
  // 正常结束连接, 但没有 [DONE]
  'no-done': (res) => stream(res, sse('{"pass":true}', { done: false })),
  // 200 的流里夹带错误对象 (上游引擎崩溃、网关转发的中途错误), 随后照常 [DONE]
  'stream-error': (res) =>
    stream(
      res,
      `data: ${JSON.stringify({ error: { message: 'engine overloaded' } })}\n\n` +
        'data: [DONE]\n\n'
    ),
  // 正文吐了一半才报错, 错误对象里带着上游的状态码
  'stream-error-502': (res) =>
    stream(
      res,
      sse('{"pass":', { done: false }) +
        `data: ${JSON.stringify({ error: { code: 502, message: 'upstream bad gateway' }, choices: [{ delta: {}, finish_reason: 'error' }] })}\n\n` +
        'data: [DONE]\n\n'
    ),
  'stream-error-400': (res) =>
    stream(
      res,
      `data: ${JSON.stringify({ error: { code: '400', message: 'content rejected by provider' } })}\n\n`
    ),
  'bad-json': (res) => stream(res, sse('我认为这条内容没有问题')),
  'bad-shape': (res) => stream(res, sse('{"code":"AD"}')),
  empty: (res) => stream(res, sse('')),
  ok: (res) => stream(res, sse('{"pass":true}'))
}

let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const scenario = JSON.parse(body).messages[1].content as string
      scenarios[scenario](res)
    })
  })
  const { promise, resolve } = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', resolve)
  await promise
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  vi.stubEnv('MODERATION_AI_BASE_URL', baseUrl)
  vi.stubEnv('MODERATION_AI_API_KEY', 'test-key')
  vi.stubEnv('MODERATION_AI_TEXT_MODEL', 'test-model')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  server.closeAllConnections()
  const { promise, resolve } = Promise.withResolvers<unknown>()
  server.close(resolve)
  await promise
})

const failureOf = async (scenario: string) => {
  const error = await moderateText('comment', scenario).then(
    () => null,
    (reason: unknown) => reason
  )
  expect(error).toBeInstanceOf(DependencyFailure)
  return error as DependencyFailure
}

describe('模型调用失败的分类', () => {
  it('对照: 正常应答不抛错', async () => {
    await expect(moderateText('comment', 'ok')).resolves.toMatchObject({
      verdict: { pass: true }
    })
  })

  it('503 带 Retry-After 秒数 → transient', async () => {
    expect(await failureOf('503')).toMatchObject({
      dependency: 'moderation_ai',
      scope: 'transient',
      status: 503,
      retryAfterMs: 120_000,
      message: 'Moderation AI request failed with status 503'
    })
  })

  it('429 带 HTTP-date 形式的 Retry-After → rate_limited, 换算成距今的毫秒数', async () => {
    const failure = await failureOf('429-date')
    const expected = Date.parse('2099-10-21T07:28:00Z') - Date.now()

    expect(failure).toMatchObject({ scope: 'rate_limited', status: 429 })
    expect(Math.abs(failure.retryAfterMs! - expected)).toBeLessThan(5_000)
  })

  it('429 没带 Retry-After → rate_limited, 等待时间未知', async () => {
    expect(await failureOf('429-bare')).toMatchObject({
      scope: 'rate_limited',
      retryAfterMs: null
    })
  })

  it.each([
    ['401', 401],
    ['404', 404]
  ])('%s → misconfigured', async (scenario, status) => {
    expect(await failureOf(scenario)).toMatchObject({
      scope: 'misconfigured',
      status
    })
  })

  it('400 → request: 依赖拒绝的是这一次请求', async () => {
    expect(await failureOf('400')).toMatchObject({
      scope: 'request',
      status: 400
    })
  })

  it('网关 504 → transient', async () => {
    expect(await failureOf('504')).toMatchObject({
      scope: 'transient',
      status: 504
    })
  })

  it('挂起直到超时 → transient', async () => {
    const failure = await failureOf('hang')

    expect(failure).toMatchObject({ scope: 'transient', status: null })
    expect(failure.cause).toMatchObject({ name: 'TimeoutError' })
  })

  // worker 在作业关停的宽限期满时中止在途调用: 不等超时, 抛出的就是中止的原因 (分类表认不出
  // 它, 不说成依赖的失败; worker 按自己的信号判定是中止, 不看错误的样子)
  it('调用方的 signal 中止: 不等超时就放弃请求, 抛出中止的原因', async () => {
    const controller = new AbortController()
    const reason = new Error('grace expired')
    const started = Date.now()
    setTimeout(() => controller.abort(reason), 20)

    const failure = await moderateTextWith(
      loadModerationPolicy(),
      'comment',
      'hang',
      controller.signal
    ).then(
      () => null,
      (error: unknown) => error
    )

    expect(failure).toBe(reason)
    expect(Date.now() - started).toBeLessThan(200)
  })

  it('正文读到一半连接被掐断 → transient', async () => {
    const failure = await failureOf('cut')

    expect(failure).toMatchObject({
      scope: 'transient',
      status: null,
      message: 'TypeError: terminated (UND_ERR_SOCKET)'
    })
  })

  it('流正常结束但没有 [DONE] → transient', async () => {
    expect(await failureOf('no-done')).toMatchObject({
      scope: 'transient',
      message: 'Moderation AI stream ended without [DONE]'
    })
  })

  // 不认错误对象的话这是「正文为空」→ request: 上游一出问题每条任务都白扣三次重试
  it('200 的流里夹带错误对象 → transient, 消息带上 provider 的原话', async () => {
    expect(await failureOf('stream-error')).toMatchObject({
      scope: 'transient',
      status: null,
      message: 'Moderation AI stream reported an error: engine overloaded'
    })
  })

  it('流里的错误对象带状态码时按状态码分类', async () => {
    expect(await failureOf('stream-error-502')).toMatchObject({
      scope: 'transient',
      status: 502,
      message: 'Moderation AI stream reported an error: upstream bad gateway'
    })
    expect(await failureOf('stream-error-400')).toMatchObject({
      scope: 'request',
      status: 400
    })
  })

  it('连不上 → transient', async () => {
    // 关掉一个刚监听过的端口, 保证没人在听
    const dead = createServer()
    const listening = Promise.withResolvers<void>()
    dead.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    const { port } = dead.address() as AddressInfo
    const closed = Promise.withResolvers<unknown>()
    dead.close(closed.resolve)
    await closed.promise

    vi.stubEnv('MODERATION_AI_BASE_URL', `http://127.0.0.1:${port}/v1`)
    try {
      expect(await failureOf('ok')).toMatchObject({
        scope: 'transient',
        status: null,
        message: 'TypeError: fetch failed (ECONNREFUSED)'
      })
    } finally {
      vi.stubEnv('MODERATION_AI_BASE_URL', baseUrl)
    }
  })

  it.each([
    ['bad-json', /not valid JSON/],
    ['bad-shape', /Invalid moderation verdict shape/],
    ['empty', /AI 返回正文为空/]
  ])('输出不合约定 (%s) → request', async (scenario, message) => {
    const failure = await failureOf(scenario)

    expect(failure).toMatchObject({ scope: 'request', status: null })
    expect(failure.message).toMatch(message)
  })

  it('地址或密钥没配 → misconfigured: 与 provider 回 401 一样对所有任务成立', async () => {
    vi.stubEnv('MODERATION_AI_API_KEY', '')
    try {
      expect(await failureOf('ok')).toMatchObject({
        scope: 'misconfigured',
        status: null,
        message:
          'MODERATION_AI_BASE_URL or MODERATION_AI_API_KEY is not configured'
      })
    } finally {
      vi.stubEnv('MODERATION_AI_API_KEY', 'test-key')
    }
  })

  // 不配某一类模型是有意的部署方式, 不是依赖故障
  it('这一类模型没配 → ModerationConfigError, 不是 DependencyFailure', async () => {
    vi.stubEnv('MODERATION_AI_TEXT_MODEL', '')
    try {
      await expect(moderateText('comment', 'ok')).rejects.toBeInstanceOf(
        ModerationConfigError
      )
    } finally {
      vi.stubEnv('MODERATION_AI_TEXT_MODEL', 'test-model')
    }
  })
})
