import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

vi.mock('next/server', () => ({
  NextRequest: class {}
}))

import { kunParseGetQuery, kunParsePostBody } from '../parseQuery'

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
