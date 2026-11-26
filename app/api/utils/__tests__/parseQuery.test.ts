import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

vi.mock('next/server', () => ({
  NextRequest: class {}
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import {
  kunParseFormData,
  kunParseGetQuery,
  kunParsePostBody,
  kunParsePutBody
} from '../parseQuery'
import { KUN_BODY_BUDGET } from '~/constants/bodyBudget'

const schema = z.object({
  page: z.coerce.number().min(1, { message: '页数最小为 1' }),
  search: z
    .string()
    .max(10, { message: '搜索关键词不能超过 10 个字符' })
    .optional()
})

const createGetRequest = (query: string) =>
  new Request(`http://localhost/api/test${query}`) as unknown as Parameters<
    typeof kunParseGetQuery
  >[0]

const createPostRequest = (body: unknown) =>
  new Request('http://localhost/api/test', {
    method: 'POST',
    body: JSON.stringify(body)
  }) as unknown as Parameters<typeof kunParsePostBody>[0]

describe('kunParseGetQuery', () => {
  it('成功时返回解析后的数据', () => {
    const result = kunParseGetQuery(
      createGetRequest('?page=2&search=kun'),
      schema
    )
    expect(result).toEqual({ page: 2, search: 'kun' })
  })

  it('多条 issue 以换行连接', () => {
    const result = kunParseGetQuery(
      createGetRequest(`?page=0&search=${'a'.repeat(11)}`),
      schema
    )
    expect(result).toBe('页数最小为 1\n搜索关键词不能超过 10 个字符')
  })

  it('错误串不是合法 JSON (kunErrorHandler 依赖 JSON.parse 抛异常落 catch 分支)', () => {
    const result = kunParseGetQuery(createGetRequest('?page=0'), schema)
    expect(typeof result).toBe('string')
    expect(() => JSON.parse(result as string)).toThrow()
  })
})

describe('kunParsePostBody', () => {
  it('校验失败时返回 issue 的人话消息', async () => {
    const result = await kunParsePostBody(
      createPostRequest({ page: 1, search: 'a'.repeat(11) }),
      schema
    )
    expect(result).toBe('搜索关键词不能超过 10 个字符')
  })

  it('body 不是合法 JSON 时返回字符串错误而非 reject', async () => {
    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: 'not json'
    }) as unknown as Parameters<typeof kunParsePostBody>[0]

    const result = await kunParsePostBody(req, schema)
    expect(typeof result).toBe('string')
  })
})

describe('兜底文案与去重', () => {
  it('没写文案的约束输出中文, 写了的原样保留', () => {
    const loose = z.object({
      name: z.string().min(1),
      page: z.coerce.number().min(1, { message: '页数最小为 1' })
    })
    const result = kunParseGetQuery(createGetRequest('?name=&page=0'), loose)
    expect(result).toBe('内容不能为空\n页数最小为 1')
  })

  it('畸形 JSON 请求体也是中文', async () => {
    const req = new Request('http://localhost/api/test', {
      method: 'POST',
      body: '{'
    }) as unknown as Parameters<typeof kunParsePostBody>[0]
    await expect(kunParsePostBody(req, schema)).resolves.toBe('参数类型不正确')
  })

  it('同一句文案只出现一次', () => {
    const ids = z.object({
      id: z.coerce.number({ message: 'ID 无效' }).int().max(10)
    })
    const result = kunParseGetQuery(
      createGetRequest('?id=9007199254740992'),
      ids
    )
    expect(result).toBe('ID 无效')
  })
})

type BodyRequest = Parameters<typeof kunParsePostBody>[0]

const bodyRequest = (
  method: 'POST' | 'PUT',
  body: BodyInit,
  headers: Record<string, string> = {}
) =>
  new Request('http://localhost/api/test', {
    method,
    body,
    headers
  }) as unknown as BodyRequest

// 只有 kunReadBody 读的三样; 用来造读完比 Content-Length 少的请求体 (proxy 克隆截断之后的样子)
const truncatedRequest = (bytes: Uint8Array<ArrayBuffer>, declared: number) =>
  ({
    url: 'http://localhost/api/test',
    headers: new Headers({ 'content-length': String(declared) }),
    body: new Response(bytes).body
  }) as unknown as BodyRequest

describe('请求体的字节预算', () => {
  it.each([
    ['POST', kunParsePostBody],
    ['PUT', kunParsePutBody]
  ] as const)('%s: 预算之内照常交给 schema', async (method, parse) => {
    await expect(
      parse(bodyRequest(method, JSON.stringify({ page: 2 })), schema)
    ).resolves.toEqual({ page: 2 })
    await expect(parse(bodyRequest(method, 'not json'), schema)).resolves.toBe(
      '参数类型不正确'
    )
  })

  it.each([
    ['POST', kunParsePostBody],
    ['PUT', kunParsePutBody]
  ] as const)(
    '%s: 默认预算 1 MiB, 超出即拒绝, 不交给 schema',
    async (method, parse) => {
      const big = JSON.stringify({
        page: 1,
        pad: 'a'.repeat(KUN_BODY_BUDGET.json)
      })

      await expect(parse(bodyRequest(method, big), schema)).resolves.toBe(
        '请求内容超过 1 MB, 请缩小后重试'
      )
    }
  )

  it.each([
    ['POST', kunParsePostBody],
    ['PUT', kunParsePutBody]
  ] as const)('%s: 入口声明的预算优先于默认值', async (method, parse) => {
    const body = JSON.stringify({ page: 1, search: 'kun' })

    await expect(
      parse(bodyRequest(method, body), schema, { maxBytes: body.length - 1 })
    ).resolves.toBe('请求内容超过 1 KB, 请缩小后重试')
    await expect(
      parse(bodyRequest(method, body), schema, { maxBytes: body.length })
    ).resolves.toEqual({ page: 1, search: 'kun' })
  })

  it('JSON 被截断 (读到的比 Content-Length 少) 回截断的文案', async () => {
    const bytes = new TextEncoder().encode(
      '{"page":1'
    ) as Uint8Array<ArrayBuffer>

    await expect(
      kunParsePostBody(truncatedRequest(bytes, 100), schema)
    ).resolves.toBe('请求内容超过 10 MB, 请缩小后重试')
  })
})

describe('kunParseFormData', () => {
  const fileSchema = z.object({
    name: z.string(),
    image: z.instanceof(File)
  })

  // 以 FormData 为源的 Request 被取消后 undici 会异步抛出未捕获的错误: 先序列化成字节
  const multipart = async (size: number) => {
    const form = new FormData()
    form.append('name', '封面')
    form.append('image', new Blob([new Uint8Array(size)]), 'a.png')
    const response = new Response(form)
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') as string
    }
  }

  it('预算之内解析出字段与文件', async () => {
    const { bytes, contentType } = await multipart(1000)
    const req = bodyRequest('POST', bytes, { 'content-type': contentType })

    const result = await kunParseFormData(req, fileSchema, { maxBytes: 2000 })

    expect(result).toMatchObject({ name: '封面' })
    expect((result as { image: File }).image.size).toBe(1000)
  })

  it('超过预算回中文文案', async () => {
    const { bytes, contentType } = await multipart(1000)
    const req = bodyRequest('POST', bytes, {
      'content-type': contentType,
      'content-length': String(bytes.byteLength)
    })

    await expect(
      kunParseFormData(req, fileSchema, { maxBytes: 500 })
    ).resolves.toBe('请求内容超过 1 KB, 请缩小后重试')
  })

  it('带 Content-Length 的截断回截断的文案, 不再抛 TypeError 变成 500', async () => {
    const { bytes, contentType } = await multipart(1000)
    const req = truncatedRequest(bytes.slice(0, 600), bytes.byteLength)
    req.headers.set('content-type', contentType)

    await expect(
      kunParseFormData(req, fileSchema, { maxBytes: KUN_BODY_BUDGET.image })
    ).resolves.toBe('请求内容超过 10 MB, 请缩小后重试')
  })

  it('没有 Content-Length 的截断与畸形表单回解析失败的文案', async () => {
    const { bytes, contentType } = await multipart(1000)
    const cut = bodyRequest('POST', bytes.slice(0, 600), {
      'content-type': contentType
    })
    const noType = bodyRequest('POST', 'name=x')
    noType.headers.delete('content-type')

    for (const req of [cut, noType]) {
      await expect(
        kunParseFormData(req, fileSchema, { maxBytes: KUN_BODY_BUDGET.image })
      ).resolves.toBe('表单内容不完整或格式不正确, 请重试')
    }
  })
})
