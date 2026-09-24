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

  it('校验失败时返回 issue 的人话消息', () => {
    const result = kunParseGetQuery(
      createGetRequest(`?page=1&search=${'a'.repeat(11)}`),
      schema
    )
    expect(result).toBe('搜索关键词不能超过 10 个字符')
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
