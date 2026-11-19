import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KUN_FETCH_NETWORK_MESSAGE,
  KUN_FETCH_PARSE_MESSAGE,
  isKunTransportFailure,
  kunFetchDelete,
  kunFetchFormData,
  kunFetchGet,
  kunFetchPost,
  kunFetchPut
} from '../kunFetch'

const fetchMock = vi.fn()
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD', 'https://kun.test')
  // 失败照旧记到控制台, 测试里不让它刷屏
  consoleErrorSpy = vi
    .spyOn(console, 'error')
    .mockImplementation(() => undefined)
})

afterEach(() => {
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// 线上会出现的六种应答: 每一种都必须 resolve, 失败一律是字符串
describe('kunFetch 的应答解析表', () => {
  it('fetch 抛错 (断网、DNS、CORS) 返回固定的网络失败文案', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(kunFetchGet('/patch')).resolves.toBe(KUN_FETCH_NETWORK_MESSAGE)
  })

  it('5xx 且没有可用的原因时返回带状态码的文案', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 502 }))

    await expect(kunFetchPost('/patch')).resolves.toBe(
      '服务暂时不可用, 请稍后重试 (HTTP 502)'
    )
  })

  it('非 2xx 的响应体是 JSON 字符串时带上服务端给的原因, 仍以状态码结尾', async () => {
    fetchMock.mockResolvedValue(jsonResponse('非法请求来源', 403))

    await expect(kunFetchPut('/patch')).resolves.toBe('非法请求来源 (HTTP 403)')
  })

  it('200 + JSON 字符串是业务失败, 原样返回', async () => {
    fetchMock.mockResolvedValue(jsonResponse('用户未登录'))

    await expect(kunFetchDelete('/patch')).resolves.toBe('用户未登录')
  })

  it('200 + JSON 对象是成功值', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ total: 3 }))

    await expect(kunFetchGet('/patch')).resolves.toEqual({ total: 3 })
  })

  it('200 但响应体不是 JSON (网关回了 HTML) 返回固定的解析失败文案', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html><body>Bad Gateway</body></html>', { status: 200 })
    )

    await expect(kunFetchGet('/patch')).resolves.toBe(KUN_FETCH_PARSE_MESSAGE)
  })
})

describe('非 2xx 的原因提取', () => {
  it.each([
    ['HTML 错误页', new Response('<h1>502</h1>', { status: 502 })],
    ['JSON 对象', jsonResponse({ message: '内部错误' }, 500)],
    ['空的 JSON 字符串', jsonResponse('', 503)],
    ['只有空白的 JSON 字符串', jsonResponse('  ', 504)]
  ])('%s 不算原因, 退回带状态码的文案', async (_, response) => {
    fetchMock.mockResolvedValue(response)

    await expect(kunFetchGet('/patch')).resolves.toBe(
      `服务暂时不可用, 请稍后重试 (HTTP ${response.status})`
    )
  })

  it('4xx 没有原因时不说「稍后重试」', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 413 }))

    await expect(kunFetchPost('/patch')).resolves.toBe(
      '请求未能完成 (HTTP 413)'
    )
  })
})

// 旧契约下会抛异常的那些应答: 断网、任何非 2xx (带不带原因)、应答不是 JSON
describe('没有得到 2xx 应答时的文案', () => {
  const synthesized = async () => {
    const results: unknown[] = []
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    results.push(await kunFetchGet('/patch'))
    for (const status of [404, 413, 429, 500, 502, 504]) {
      fetchMock.mockResolvedValueOnce(new Response('', { status }))
      results.push(await kunFetchGet('/patch'))
    }
    fetchMock.mockResolvedValueOnce(jsonResponse('非法请求来源', 403))
    results.push(await kunFetchGet('/patch'))
    fetchMock.mockResolvedValueOnce(jsonResponse('用户登录失效', 401))
    results.push(await kunFetchGet('/patch'))
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    results.push(await kunFetchGet('/patch'))
    return results as string[]
  }

  // kunErrorHandler 先对字符串 JSON.parse, 解析成功会走「未知错误」分支而不是原样展示
  it('都不是合法 JSON', async () => {
    for (const message of await synthesized()) {
      expect(typeof message).toBe('string')
      expect(() => JSON.parse(message)).toThrow()
    }
  })

  it('isKunTransportFailure 认得出全部', async () => {
    for (const message of await synthesized()) {
      expect(isKunTransportFailure(message)).toBe(true)
    }
  })

  // 处理器以 200 给出的拒绝是业务失败; 文案里碰巧带着相近字眼也不算
  it.each([
    '用户未登录',
    '网络游戏不可重复提交',
    '网络连接失败',
    '服务暂时不可用',
    '请求未能完成',
    'HTTP 链接无效 (HTTP)',
    '状态码 (HTTP 403) 不受支持',
    '服务器返回了无法识别的内容'
  ])('处理器以 200 答复的「%s」不算', async (message) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(message))

    const res = await kunFetchGet('/patch')

    expect(res).toBe(message)
    expect(isKunTransportFailure(res)).toBe(false)
  })

  it('成功值与非字符串不算', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ total: 3 }))
    expect(isKunTransportFailure(await kunFetchGet('/patch'))).toBe(false)

    expect(isKunTransportFailure(null)).toBe(false)
    expect(isKunTransportFailure(undefined)).toBe(false)
  })

  it.each([
    [
      '断网',
      () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    ],
    [
      '非 2xx',
      () => fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    ],
    ['应答不是 JSON', () => fetchMock.mockResolvedValue(new Response('<html>'))]
  ])('%s 记到控制台一次', async (_, arrange) => {
    arrange()

    await expect(kunFetchGet('/patch')).resolves.toBeTypeOf('string')

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('成功与业务失败不记控制台', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ total: 3 }))
    fetchMock.mockResolvedValueOnce(jsonResponse('用户未登录'))

    await expect(kunFetchGet('/patch')).resolves.toEqual({ total: 3 })
    await expect(kunFetchGet('/patch')).resolves.toBe('用户未登录')

    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })
})

describe('请求的形状', () => {
  it('GET 把 query 拼进地址, 带上凭据与 CSRF 头', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))

    await expect(
      kunFetchGet('/patch', { page: 2, keyword: 'a b' })
    ).resolves.toEqual({})

    expect(fetchMock).toHaveBeenCalledWith(
      'https://kun.test/api/patch?page=2&keyword=a+b',
      {
        method: 'GET',
        credentials: 'include',
        mode: 'cors',
        headers: { 'X-Requested-With': 'kun-fetch' }
      }
    )
  })

  it('POST / PUT 把 body 序列化成 JSON, DELETE 走 query', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}))

    await expect(kunFetchPost('/patch', { id: 1 })).resolves.toEqual({})
    await expect(kunFetchPut('/patch', { id: 2 })).resolves.toEqual({})
    await expect(kunFetchDelete('/patch', { id: 3 })).resolves.toEqual({})

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init])).toEqual([
      [
        'https://kun.test/api/patch',
        expect.objectContaining({ method: 'POST', body: '{"id":1}' })
      ],
      [
        'https://kun.test/api/patch',
        expect.objectContaining({ method: 'PUT', body: '{"id":2}' })
      ],
      [
        'https://kun.test/api/patch?id=3',
        expect.objectContaining({ method: 'DELETE' })
      ]
    ])
  })

  it('表单请求原样带上 FormData', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    const formData = new FormData()
    formData.append('image', new Blob(['x']))

    await expect(kunFetchFormData('/user/image', formData)).resolves.toEqual({})

    expect(fetchMock).toHaveBeenCalledWith(
      'https://kun.test/api/user/image',
      expect.objectContaining({ method: 'POST', body: formData })
    )
  })

  // 漏传 formData 是调用方写错了, 不是运行时会遇到的失败, 仍然抛出
  it('漏传 FormData 属于编程错误, 仍然 reject', async () => {
    await expect(kunFetchFormData('/user/image')).rejects.toThrow(
      'formData is required'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// 返回类型里必须带 string: 裸泛型的调用点不收窄就访问字段要编译失败 (pnpm typecheck 执法)。
// isKunTransportFailure 不是类型谓词, 排除掉传输失败之后值仍可能是业务失败的字符串
export const kunFetchTypeProbe = async () => {
  const res = await kunFetchGet<{ total: number }>('/patch')
  // @ts-expect-error 没收窄之前不能当成功值用
  const total: number = res.total
  if (isKunTransportFailure(res)) {
    return total
  }
  // @ts-expect-error 只排除了传输失败, 还没排除业务失败
  const afterPredicate: number = res.total
  return typeof res === 'string' ? res : res.total + afterPredicate
}
