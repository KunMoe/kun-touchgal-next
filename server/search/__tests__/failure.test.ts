import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Meilisearch } from 'meilisearch'

const { isMeiliEnabledMock } = vi.hoisted(() => ({
  isMeiliEnabledMock: vi.fn()
}))

vi.mock('~/lib/meilisearch', () => ({
  isMeiliEnabled: isMeiliEnabledMock
}))

import {
  MeiliBadRequestError,
  classifyMeiliFailure,
  withMeiliEngine
} from '~/server/search/failure'
import { meiliApiError, meiliDown } from './meiliErrors'

// 真实的 SDK + 桩掉的 fetch: 钉住的是「SDK 把各种失败抛成什么样, 我们又怎么归类」。
// 应答体取自对本机 Meilisearch v1.15 的实测 (meilisearch-js 0.63), 升级 SDK 或引擎后
// 变红时先看新的错误形状, 不要机械改断言
const meiliError = (code: string, type = 'invalid_request') =>
  JSON.stringify({ message: `stub ${code}`, code, type, link: '' })

const failWith = async (fetchImpl: () => Promise<Response>) => {
  vi.stubGlobal('fetch', fetchImpl)
  const client = new Meilisearch({ host: 'http://meili.invalid', apiKey: 'k' })
  try {
    await client.index('galgame').search('kun', { page: 1, hitsPerPage: 12 })
  } catch (error) {
    return error
  }
  throw new Error('search 没有抛错')
}

const respond = (status: number, body: string) => async () =>
  new Response(body, { status })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('classifyMeiliFailure: Meilisearch 自身不可用', () => {
  it('超时 (AbortSignal.timeout 的 TimeoutError)', async () => {
    const error = await failWith(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError')
    })

    expect(classifyMeiliFailure(error)).toBe('transient')
  })

  it('拒连 (fetch failed)', async () => {
    const error = await failWith(async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    })

    expect(classifyMeiliFailure(error)).toBe('transient')
  })

  it('500', async () => {
    const error = await failWith(respond(500, meiliError('internal')))

    expect(classifyMeiliFailure(error)).toBe('transient')
  })

  it('反向代理回的 502, 正文不是 JSON', async () => {
    const error = await failWith(respond(502, '<html>Bad Gateway</html>'))

    expect(classifyMeiliFailure(error)).toBe('transient')
  })

  it('429', async () => {
    const error = await failWith(respond(429, ''))

    expect(classifyMeiliFailure(error)).toBe('rate_limited')
  })
})

describe('classifyMeiliFailure: 这一次请求的参数非法', () => {
  it.each([
    'invalid_search_page',
    'invalid_search_hits_per_page',
    'invalid_search_limit',
    'invalid_search_offset',
    'invalid_search_q',
    'malformed_payload'
  ])('400 %s', async (code) => {
    const error = await failWith(respond(400, meiliError(code)))

    expect(classifyMeiliFailure(error)).toBe('request')
  })
})

describe('classifyMeiliFailure: 索引与代码不一致', () => {
  it.each([
    [400, 'invalid_search_sort'],
    [400, 'invalid_search_filter'],
    [400, 'invalid_search_attributes_to_search_on'],
    [404, 'index_not_found']
  ])('%i %s', async (status, code) => {
    const error = await failWith(respond(status, meiliError(code)))

    expect(classifyMeiliFailure(error)).toBe('misconfigured')
  })

  it.each([
    [403, 'invalid_api_key'],
    [401, 'missing_authorization_header']
  ])('%i %s', async (status, code) => {
    const error = await failWith(respond(status, meiliError(code, 'auth')))

    expect(classifyMeiliFailure(error)).toBe('misconfigured')
  })

  it('地址指到了别的服务: 404 且正文不是 JSON', async () => {
    const error = await failWith(respond(404, '<html>Not Found</html>'))

    expect(classifyMeiliFailure(error)).toBe('misconfigured')
  })
})

describe('classifyMeiliFailure: 判别方式', () => {
  it('不靠 instanceof: 另一份 SDK 实例抛出的同形错误照样认得', () => {
    expect(
      classifyMeiliFailure({
        name: 'MeilisearchApiError',
        response: { status: 400 },
        cause: { code: 'invalid_search_page' }
      })
    ).toBe('request')
    expect(classifyMeiliFailure({ name: 'MeilisearchRequestError' })).toBe(
      'transient'
    )
  })

  it.each([
    ['普通 Error', new Error('boom')],
    ['TypeError', new TypeError('x is not a function')],
    [
      'Prisma 错误',
      Object.assign(new Error('pool timeout'), {
        name: 'PrismaClientKnownRequestError',
        code: 'P2024'
      })
    ],
    // 带 code 但不是 Meilisearch 的错误: 不能因为 code 撞名就被当成请求参数非法
    ['带同名 code 的别的错误', { name: 'Error', code: 'invalid_search_page' }],
    ['字符串', 'boom'],
    ['null', null],
    ['undefined', undefined]
  ])('不是 Meilisearch 的错误返回 null: %s', (_name, error) => {
    expect(classifyMeiliFailure(error)).toBeNull()
  })
})

describe('withMeiliEngine', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetAllMocks()
    isMeiliEnabledMock.mockReturnValue(true)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('未启用时只跑 basic', async () => {
    isMeiliEnabledMock.mockReturnValue(false)
    const meili = vi.fn()
    const basic = vi.fn().mockResolvedValue('from-basic')

    expect(await withMeiliEngine(meili, basic)).toEqual({
      engine: 'basic',
      value: 'from-basic'
    })
    expect(meili).not.toHaveBeenCalled()
  })

  it('启用且成功时只跑 meili', async () => {
    const meili = vi.fn().mockResolvedValue('from-meili')
    const basic = vi.fn()

    expect(await withMeiliEngine(meili, basic)).toEqual({
      engine: 'meili',
      value: 'from-meili'
    })
    expect(basic).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('Meilisearch 不可用时换到 basic, 记 warn', async () => {
    const meili = vi.fn().mockRejectedValue(meiliDown())
    const basic = vi.fn().mockResolvedValue('from-basic')

    expect(await withMeiliEngine(meili, basic)).toEqual({
      engine: 'basic',
      value: 'from-basic'
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.any(String), {
      name: 'MeilisearchRequestError',
      message: 'Request to http://meili has failed',
      cause: 'TimeoutError'
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('索引没配好时仍换到 basic, 但记 error', async () => {
    const meili = vi
      .fn()
      .mockRejectedValue(meiliApiError(400, 'invalid_search_sort'))
    const basic = vi.fn().mockResolvedValue('from-basic')

    expect(await withMeiliEngine(meili, basic)).toEqual({
      engine: 'basic',
      value: 'from-basic'
    })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), {
      name: 'MeilisearchApiError',
      status: 400,
      code: 'invalid_search_sort',
      message: 'stub invalid_search_sort'
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('请求参数被拒时不换引擎, 抛 MeiliBadRequestError 并带上原错误', async () => {
    const original = meiliApiError(400, 'invalid_search_page')
    const meili = vi.fn().mockRejectedValue(original)
    const basic = vi.fn()

    const thrown = await withMeiliEngine(meili, basic).catch(
      (error: unknown) => error
    )

    expect(thrown).toBeInstanceOf(MeiliBadRequestError)
    expect((thrown as Error).cause).toBe(original)
    expect(basic).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('不是 Meilisearch 的异常原样抛出, 不换引擎', async () => {
    const original = new Error('pg down')
    const meili = vi.fn().mockRejectedValue(original)
    const basic = vi.fn()

    await expect(withMeiliEngine(meili, basic)).rejects.toBe(original)
    expect(basic).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('换到 basic 之后 basic 自己的失败原样抛出', async () => {
    const original = new Error('pg down')
    const meili = vi.fn().mockRejectedValue(meiliDown())
    const basic = vi.fn().mockRejectedValue(original)

    await expect(withMeiliEngine(meili, basic)).rejects.toBe(original)
    expect(basic).toHaveBeenCalledTimes(1)
  })
})
