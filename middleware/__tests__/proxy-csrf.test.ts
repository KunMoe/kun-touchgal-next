import { beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'

// /api 的 CSRF 门由两处合力生效: proxy.ts 的 config.matcher 决定 proxy 是否运行, proxy() 决定
// 运行后是否拦截。/api/upload/* 曾被 matcher 排除、由 handler 自行补校验, 那个目录下新增的路由
// 默认不受保护; 这里两侧各钉一遍, 任何 /api 路由重新被排除出 matcher 都会变红

// middleware/_csrf.ts 在模块加载时读允许的 host, 故先设 env 再动态 import (同 _csrf.test.ts)
let proxy: (request: NextRequest) => Promise<Response>
let config: { matcher: string[] }
let HEADER: string
let HEADER_VALUE: string

const ORIGIN = 'http://127.0.0.1:3000'

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV', ORIGIN)
  const csrf = await import('~/middleware/_csrf')
  HEADER = csrf.KUN_CSRF_HEADER
  HEADER_VALUE = csrf.KUN_CSRF_HEADER_VALUE
  const mod = await import('~/proxy')
  proxy = mod.proxy
  config = mod.config
})

const UPLOAD_ROUTES = ['/api/upload/init', '/api/upload/complete']

// 与构建时编译 matcher 的是同一个函数 (getMiddlewareMatchers), 不是测试自己的近似
const matches = (pathname: string) =>
  unstable_doesMiddlewareMatch({ config, url: pathname })

const post = (pathname: string, headers: Record<string, string>) =>
  new NextRequest(`${ORIGIN}${pathname}`, {
    method: 'POST',
    headers,
    body: '{}'
  })

describe('proxy matcher 覆盖全部 /api 路由', () => {
  it.each(UPLOAD_ROUTES)('%s 进入 proxy', (pathname) => {
    expect(matches(pathname)).toBe(true)
  })

  // 没有 matcher 时这个函数恒返回 true, 反例防止上面的断言空转
  it('对照: 普通 /api 路由进入, 不在 matcher 里的页面不进', () => {
    expect(matches('/api/patch/comment')).toBe(true)
    expect(matches('/galgame')).toBe(false)
  })
})

describe('proxy 对上传路由执行 CSRF', () => {
  it.each(UPLOAD_ROUTES)(
    '%s 缺 x-requested-with 时 403 回 CSRF 错误串',
    async (pathname) => {
      const res = await proxy(post(pathname, { origin: ORIGIN }))

      expect(res.status).toBe(403)
      expect(await res.json()).toBe('非法请求来源')
      expect(res.headers.get('x-middleware-next')).toBeNull()
    }
  )

  // NextResponse.next() 以 x-middleware-next: 1 标记「继续交给路由」
  // (next/dist/server/web/spec-extension/response.js)
  it.each(UPLOAD_ROUTES)(
    '%s 带对的头与允许的 origin 时放行',
    async (pathname) => {
      const res = await proxy(
        post(pathname, { [HEADER]: HEADER_VALUE, origin: ORIGIN })
      )

      expect(res.status).toBe(200)
      expect(res.headers.get('x-middleware-next')).toBe('1')
    }
  )
})
