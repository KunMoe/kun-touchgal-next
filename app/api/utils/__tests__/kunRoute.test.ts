import * as z from 'zod'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  verifyKunCsrfMock,
  getQueryMock,
  deleteQueryMock,
  postBodyMock,
  putBodyMock,
  formDataMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  verifyKunCsrfMock: vi.fn(),
  getQueryMock: vi.fn(),
  deleteQueryMock: vi.fn(),
  postBodyMock: vi.fn(),
  putBodyMock: vi.fn(),
  formDataMock: vi.fn()
}))

// 与路由测试同样的 mock 形状: next/server 只有 NextResponse.json
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json' }
      })
  }
}))
vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))
vi.mock('~/middleware/_csrf', () => ({ verifyKunCsrf: verifyKunCsrfMock }))
vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParseGetQuery: getQueryMock,
  kunParseDeleteQuery: deleteQueryMock,
  kunParsePostBody: postBodyMock,
  kunParsePutBody: putBodyMock,
  kunParseFormData: formDataMock
}))

import { kunRoute } from '~/app/api/utils/kunRoute'

const req = new Request('http://localhost/api/x') as unknown as NextRequest
const schema = z.object({ id: z.coerce.number() })
const user = { uid: 7, role: 1, name: 'kun' }
const superAdmin = { uid: 1, role: 4, name: 'root' }

const body = async (response: Response) => response.json()

beforeEach(() => {
  vi.resetAllMocks()
  verifyKunCsrfMock.mockReturnValue(null)
})

describe('访问级别', () => {
  it('public 不读会话', async () => {
    const handler = vi.fn(async () => ({ ok: true }))
    const GET = kunRoute.get({ auth: 'public', handler })

    await expect(body(await GET(req))).resolves.toEqual({ ok: true })
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ actor: undefined })
    )
  })

  it('optional 游客放行, actor 为 null', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const handler = vi.fn(async () => ({}))
    await kunRoute.get({ auth: 'optional', handler })(req)

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ actor: null })
    )
  })

  it('optional 已登录时带上 actor', async () => {
    verifyHeaderCookieMock.mockResolvedValue(user)
    const handler = vi.fn(async () => ({}))
    await kunRoute.get({ auth: 'optional', handler })(req)

    expect(verifyHeaderCookieMock).toHaveBeenCalledWith(req)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ actor: user })
    )
  })

  it('user 游客拦在 handler 之前', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const handler = vi.fn(async () => ({}))
    const response = await kunRoute.get({ auth: 'user', handler })(req)

    expect(response.status).toBe(200)
    await expect(body(response)).resolves.toBe('用户未登录')
    expect(handler).not.toHaveBeenCalled()
  })

  it('user 已登录时把 actor 交给 handler', async () => {
    verifyHeaderCookieMock.mockResolvedValue(user)
    const handler = vi.fn(async () => ({}))
    await kunRoute.get({ auth: 'user', handler })(req)

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ actor: user, req })
    )
  })

  it('能力不足按能力的最低角色给出拒绝文案', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ ...user, role: 3 })
    const handler = vi.fn(async () => ({}))

    await expect(
      body(
        await kunRoute.get({
          auth: 'user',
          capability: 'admin.access',
          handler
        })(req)
      )
    ).resolves.toBe('本页面仅超级管理员可访问')

    verifyHeaderCookieMock.mockResolvedValue(user)
    await expect(
      body(
        await kunRoute.get({ auth: 'user', capability: 'tag.manage', handler })(
          req
        )
      )
    ).resolves.toBe('本页面仅管理员可访问')
    expect(handler).not.toHaveBeenCalled()
  })

  it('能力足够时放行', async () => {
    verifyHeaderCookieMock.mockResolvedValue(superAdmin)
    const handler = vi.fn(async () => ({ ok: 1 }))
    const response = await kunRoute.get({
      auth: 'user',
      capability: 'admin.access',
      handler
    })(req)

    await expect(body(response)).resolves.toEqual({ ok: 1 })
  })

  it('legacyDeny 保留迁移前的未登录文案与 401', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const response = await kunRoute.get({
      auth: 'user',
      legacyDeny: { unauthenticated: '请先登录', unauthenticatedStatus: 401 },
      handler: async () => ({})
    })(req)

    expect(response.status).toBe(401)
    await expect(body(response)).resolves.toBe('请先登录')
  })

  it('legacyDeny 只改文案时状态码仍是 200', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const response = await kunRoute.get({
      auth: 'user',
      legacyDeny: { unauthenticated: '用户登录失效' },
      handler: async () => ({})
    })(req)

    expect(response.status).toBe(200)
    await expect(body(response)).resolves.toBe('用户登录失效')
  })

  it('legacyDeny 保留迁移前的能力拒绝文案', async () => {
    verifyHeaderCookieMock.mockResolvedValue(user)
    const response = await kunRoute.put({
      auth: 'user',
      capability: 'admin.access',
      legacyDeny: { forbidden: '仅超级管理员可访问' },
      handler: async () => ({})
    })(req)

    await expect(body(response)).resolves.toBe('仅超级管理员可访问')
  })
})

describe('解析与鉴权的顺序', () => {
  it('默认先解析: 校验失败时不碰会话', async () => {
    getQueryMock.mockReturnValue('id 无效')
    const handler = vi.fn(async () => ({}))
    const response = await kunRoute.get({
      auth: 'user',
      input: schema,
      handler
    })(req)

    await expect(body(response)).resolves.toBe('id 无效')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('默认先解析: 通过后再鉴权, 输入交给 handler', async () => {
    postBodyMock.mockResolvedValue({ id: 3 })
    verifyHeaderCookieMock.mockResolvedValue(user)
    const handler = vi.fn(async () => ({}))
    await kunRoute.post({ auth: 'user', input: schema, handler })(req)

    expect(postBodyMock).toHaveBeenCalledWith(req, schema)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ input: { id: 3 }, actor: user })
    )
  })

  it('auth-first: 游客拦在解析之前', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const response = await kunRoute.post({
      auth: 'user',
      order: 'auth-first',
      input: schema,
      handler: async () => ({})
    })(req)

    await expect(body(response)).resolves.toBe('用户未登录')
    expect(postBodyMock).not.toHaveBeenCalled()
  })

  it('auth-first: 鉴权通过后解析失败返回校验消息', async () => {
    verifyHeaderCookieMock.mockResolvedValue(user)
    postBodyMock.mockResolvedValue('token 无效')
    const handler = vi.fn(async () => ({}))
    const response = await kunRoute.post({
      auth: 'user',
      order: 'auth-first',
      input: schema,
      handler
    })(req)

    await expect(body(response)).resolves.toBe('token 无效')
    expect(verifyHeaderCookieMock).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
  })

  it('不写 input 时不解析', async () => {
    verifyHeaderCookieMock.mockResolvedValue(user)
    await kunRoute.post({ auth: 'user', handler: async () => ({}) })(req)

    expect(postBodyMock).not.toHaveBeenCalled()
  })

  it('按方法选择解析函数, form 改用表单解析', async () => {
    getQueryMock.mockReturnValue({ id: 1 })
    deleteQueryMock.mockReturnValue({ id: 2 })
    postBodyMock.mockResolvedValue({ id: 3 })
    putBodyMock.mockResolvedValue({ id: 4 })
    formDataMock.mockResolvedValue({ id: 5 })
    const handler = vi.fn(async ({ input }: { input: unknown }) => ({ input }))
    const def = { auth: 'public' as const, input: schema, handler }

    const results = await Promise.all(
      [
        kunRoute.get(def),
        kunRoute.delete(def),
        kunRoute.post(def),
        kunRoute.put(def),
        kunRoute.post({ ...def, form: true }),
        kunRoute.put({ ...def, form: true })
      ].map(async (route) => body(await route(req)))
    )

    expect(results.map((result) => result.input.id)).toEqual([1, 2, 3, 4, 5, 5])
  })
})

describe('动态段', () => {
  it('最先解析, 交给 handler', async () => {
    getQueryMock.mockReturnValue({ id: 1 })
    verifyHeaderCookieMock.mockResolvedValue(user)
    const handler = vi.fn(async () => ({}))
    await kunRoute.get({
      auth: 'user',
      params: ({ id }) => Number(id),
      input: schema,
      handler
    })(req, { params: Promise.resolve({ id: '42' }) })

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ params: 42 })
    )
  })

  it('校验失败时返回消息, 不解析也不鉴权', async () => {
    const response = await kunRoute.get({
      auth: 'user',
      params: () => '无效的会话 ID',
      input: schema,
      handler: async () => ({})
    })(req, { params: Promise.resolve({ id: 'x' }) })

    await expect(body(response)).resolves.toBe('无效的会话 ID')
    expect(getQueryMock).not.toHaveBeenCalled()
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
  })

  it('路由的第二个参数缺省时按空对象解析', async () => {
    const parser = vi.fn(() => 1)
    await kunRoute.get({
      auth: 'public',
      params: parser,
      handler: async () => ({})
    })(req)

    expect(parser).toHaveBeenCalledWith({})
  })
})

describe('CSRF', () => {
  it("csrf: 'handler' 校验失败时 403, 先于解析与鉴权", async () => {
    verifyKunCsrfMock.mockReturnValue('非法请求')
    const response = await kunRoute.post({
      auth: 'user',
      csrf: 'handler',
      input: schema,
      handler: async () => ({})
    })(req)

    expect(response.status).toBe(403)
    await expect(body(response)).resolves.toBe('非法请求')
    expect(postBodyMock).not.toHaveBeenCalled()
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
  })

  it('不声明 csrf 时不校验 (由 proxy 负责)', async () => {
    await kunRoute.post({ auth: 'public', handler: async () => ({}) })(req)

    expect(verifyKunCsrfMock).not.toHaveBeenCalled()
  })
})

describe('返回值', () => {
  it('字符串以 200 返回', async () => {
    const response = await kunRoute.get({
      auth: 'public',
      handler: async () => '未找到 Galgame'
    })(req)

    expect(response.status).toBe(200)
    await expect(body(response)).resolves.toBe('未找到 Galgame')
  })

  it('Response 原样透传', async () => {
    const original = new Response('gone', { status: 410 })
    const response = await kunRoute.post({
      auth: 'public',
      handler: () => original
    })(req)

    expect(response).toBe(original)
  })

  it('handler 抛出的异常原样冒出', async () => {
    const error = Object.assign(new Error('fk'), { code: 'P2003' })
    await expect(
      kunRoute.post({
        auth: 'public',
        handler: async () => {
          throw error
        }
      })(req)
    ).rejects.toBe(error)
  })
})

describe('测试兼容', () => {
  it('parseQuery 的 mock 只给本路由用的那一个解析函数时也能加载与运行', async () => {
    vi.resetModules()
    vi.doMock('~/app/api/utils/parseQuery', () => ({
      kunParsePutBody: async () => ({ id: 9 })
    }))
    const { kunRoute: isolated } = await import('~/app/api/utils/kunRoute')
    const PUT = isolated.put({
      auth: 'public',
      input: schema,
      handler: async ({ input }) => input
    })

    await expect(body(await PUT(req))).resolves.toEqual({ id: 9 })
    vi.doUnmock('~/app/api/utils/parseQuery')
  })
})

describe('类型', () => {
  it('编译期约束 (由 pnpm typecheck 执行)', () => {
    // @ts-expect-error auth 必填
    kunRoute.get({ handler: async () => ({}) })

    kunRoute.get({
      auth: 'optional',
      handler: async ({ actor }) => {
        // @ts-expect-error optional 的 actor 可能是 null
        return { uid: actor.uid }
      }
    })

    kunRoute.get({
      auth: 'user',
      input: schema,
      handler: async ({ actor, input }) => ({ n: actor.uid + input.id })
    })

    kunRoute.get({
      auth: 'optional',
      // @ts-expect-error capability 只能跟 user
      capability: 'admin.access',
      handler: async () => ({})
    })

    kunRoute.get({
      auth: 'public',
      // @ts-expect-error public 没有拒绝文案可留
      legacyDeny: { unauthenticated: 'x' },
      handler: async () => ({})
    })

    kunRoute.post({
      auth: 'user',
      // @ts-expect-error 顶层可空的请求体 schema 会放过解析失败的 null
      input: schema.nullable(),
      handler: async () => ({})
    })

    kunRoute.head({
      auth: 'public',
      // @ts-expect-error PATCH / HEAD / OPTIONS 不解析输入
      input: schema,
      handler: async () => ({})
    })

    expect(true).toBe(true)
  })
})
