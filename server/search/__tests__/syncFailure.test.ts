import { afterEach, describe, expect, it, vi } from 'vitest'
import { Meilisearch, MeilisearchTaskTimeOutError } from 'meilisearch'

// 真实的 SDK + 桩掉的 fetch: 钉住 drain 写一份文档失败时 SDK 抛成什么样, 又被归为「引擎整体
// 收不了写入」(不计次数) 还是「这一份文档被拒」(计次数、退避、隔离)。应答体的形状取自 v1.15
// 的实测 (failure.test.ts 同款), 升级 SDK 或引擎后变红先看新的错误形状, 不要机械改断言

vi.mock('~/lib/meilisearch', () => ({
  getMeiliClient: () =>
    new Meilisearch({ host: 'http://meili.invalid', apiKey: 'k' })
}))
vi.mock('~/prisma/index', () => ({
  prisma: { patch: { findUnique: async () => ({ id: 1 }) } }
}))
vi.mock('~/server/search/document', () => ({
  PATCH_SEARCH_SELECT: {},
  patchToSearchDoc: async () => ({ id: 1 })
}))

import {
  isEngineWideWriteFailure,
  syncPatchToSearch
} from '~/server/search/sync'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })

const meiliError = (code: string, type: string) => ({
  message: `stub ${code}`,
  code,
  type,
  link: ''
})

const enqueued = {
  taskUid: 7,
  indexUid: 'galgame',
  status: 'enqueued',
  type: 'documentAdditionOrUpdate',
  enqueuedAt: '2026-11-23T00:00:00Z'
}

// 文档写入 POST 的应答, 与之后轮询任务 GET /tasks/7 的应答
const stubMeili = (
  write: () => Promise<Response>,
  task?: Record<string, unknown>
) => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/tasks/')) {
      return json(200, { ...enqueued, ...task })
    }
    return write()
  })
}

const failureOf = async () => {
  try {
    await syncPatchToSearch(1)
  } catch (error) {
    return error
  }
  throw new Error('syncPatchToSearch 没有抛错')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isEngineWideWriteFailure: 这一份文档被拒, 计次数', () => {
  it('任务失败, 错误类型 invalid_request (字段非法)', async () => {
    stubMeili(async () => json(202, enqueued), {
      status: 'failed',
      error: meiliError('invalid_document_fields', 'invalid_request')
    })

    const error = await failureOf()

    expect(error).toMatchObject({
      name: 'SearchTaskFailedError',
      code: 'invalid_document_fields'
    })
    expect(isEngineWideWriteFailure(error)).toBe(false)
  })

  it('请求体不是合法 JSON (400 malformed_payload, 孤立代理)', async () => {
    stubMeili(async () =>
      json(400, meiliError('malformed_payload', 'invalid_request'))
    )

    const error = await failureOf()

    expect(error).toMatchObject({ name: 'MeilisearchApiError' })
    expect(isEngineWideWriteFailure(error)).toBe(false)
  })

  it('请求体过大 (413 payload_too_large)', async () => {
    stubMeili(async () =>
      json(413, meiliError('payload_too_large', 'invalid_request'))
    )

    expect(isEngineWideWriteFailure(await failureOf())).toBe(false)
  })

  it('认不出的错误 (构建文档、读 PG 时抛的) 算这一行的', () => {
    expect(isEngineWideWriteFailure(new TypeError('boom'))).toBe(false)
    expect(isEngineWideWriteFailure('boom')).toBe(false)
  })
})

describe('isEngineWideWriteFailure: 引擎整体收不了写入, 不计次数', () => {
  it('拒连 (MeilisearchRequestError)', async () => {
    stubMeili(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    })

    const error = await failureOf()

    expect(error).toMatchObject({ name: 'MeilisearchRequestError' })
    expect(isEngineWideWriteFailure(error)).toBe(true)
  })

  it.each([
    [503, 'internal', 'internal'],
    [500, 'internal', 'internal'],
    [429, 'too_many_requests', 'invalid_request'],
    [408, 'request_timeout', 'invalid_request'],
    [403, 'invalid_api_key', 'auth'],
    [401, 'missing_authorization_header', 'auth'],
    [404, 'index_not_found', 'invalid_request']
  ])('HTTP %i %s', async (status, code, type) => {
    stubMeili(async () => json(status, meiliError(code, type)))

    expect(isEngineWideWriteFailure(await failureOf())).toBe(true)
  })

  it.each([
    ['system', 'no_space_left_on_device'],
    ['internal', 'internal'],
    ['auth', 'invalid_api_key'],
    ['invalid_request', 'index_not_found'],
    // 文档写入撞上不存在的索引时引擎自动建出没有主键的索引, 随后推断不出主键
    ['invalid_request', 'index_primary_key_multiple_candidates_found'],
    ['invalid_request', 'index_primary_key_no_candidate_found']
  ])('任务失败, 错误 %s / %s', async (type, code) => {
    stubMeili(async () => json(202, enqueued), {
      status: 'failed',
      error: meiliError(code, type)
    })

    expect(isEngineWideWriteFailure(await failureOf())).toBe(true)
  })

  it('应答不是 Meilisearch 的: 200 但正文是 HTML (地址指到了别的服务)', async () => {
    stubMeili(
      async () =>
        new Response('<!doctype html><title>x</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' }
        })
    )

    const error = await failureOf()

    expect(error).toMatchObject({ name: 'MeiliProtocolError' })
    expect(isEngineWideWriteFailure(error)).toBe(true)
  })

  it('应答不是 Meilisearch 的: 200 空正文', async () => {
    stubMeili(async () => new Response('', { status: 200 }))

    expect(isEngineWideWriteFailure(await failureOf())).toBe(true)
  })

  it('任务被取消', async () => {
    stubMeili(async () => json(202, enqueued), { status: 'canceled' })

    expect(isEngineWideWriteFailure(await failureOf())).toBe(true)
  })

  it('等任务终态超时 (SDK 的 MeilisearchTaskTimeOutError)', () => {
    expect(
      isEngineWideWriteFailure(new MeilisearchTaskTimeOutError(7, 30_000))
    ).toBe(true)
  })
})
