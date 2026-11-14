import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

// 对抗点: ALLOWED_HOSTS 在模块加载时求值一次, 故必须先设置 env 再动态 import。
// 这也实证了本次改动的语义 —— 值来自加载时刻的 env, 而非每请求重读。
let verifyKunCsrf: (req: NextRequest) => string | null
let HEADER: string
let HEADER_VALUE: string

const DEV = 'http://127.0.0.1:3000'
const PROD = 'https://image.touchgal.moyu.moe'

beforeAll(async () => {
  vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV', DEV)
  vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD', PROD)
  const mod = await import('~/middleware/_csrf')
  verifyKunCsrf = mod.verifyKunCsrf
  HEADER = mod.KUN_CSRF_HEADER
  HEADER_VALUE = mod.KUN_CSRF_HEADER_VALUE
})

const makeReq = (opts: {
  method?: string
  pathname?: string
  headers?: Record<string, string>
}) =>
  ({
    method: opts.method ?? 'POST',
    nextUrl: { pathname: opts.pathname ?? '/api/foo' },
    headers: {
      get: (key: string) => opts.headers?.[key.toLowerCase()] ?? null
    }
  }) as unknown as NextRequest

const withCsrf = (extra: Record<string, string>) => ({
  [HEADER]: HEADER_VALUE,
  ...extra
})

describe('verifyKunCsrf', () => {
  it('放行非状态变更方法, 即使缺少任何头', () => {
    expect(verifyKunCsrf(makeReq({ method: 'GET', headers: {} }))).toBeNull()
    expect(verifyKunCsrf(makeReq({ method: 'HEAD', headers: {} }))).toBeNull()
  })

  it('放行豁免路径的写请求, 即使缺少 CSRF 头', () => {
    const req = makeReq({
      method: 'POST',
      pathname: '/api/user/setting/email/revert',
      headers: {}
    })
    expect(verifyKunCsrf(req)).toBeNull()
  })

  it('缺少 x-requested-with 头时拒绝写请求', () => {
    expect(verifyKunCsrf(makeReq({ headers: { origin: DEV } }))).toBe(
      '非法请求来源'
    )
  })

  it('实证: 模块加载时从 env 拾取了合法 host, 匹配 origin 则放行 (DEV+PROD)', () => {
    expect(
      verifyKunCsrf(makeReq({ headers: withCsrf({ origin: DEV }) }))
    ).toBeNull()
    expect(
      verifyKunCsrf(makeReq({ headers: withCsrf({ origin: PROD }) }))
    ).toBeNull()
  })

  it('带端口/路径的 origin 只比对 host, 仍放行', () => {
    expect(
      verifyKunCsrf(
        makeReq({ headers: withCsrf({ origin: `${PROD}/some/path?q=1` }) })
      )
    ).toBeNull()
  })

  it('无 origin 时回退到 referer 校验', () => {
    expect(
      verifyKunCsrf(makeReq({ headers: withCsrf({ referer: `${DEV}/edit` }) }))
    ).toBeNull()
    expect(
      verifyKunCsrf(
        makeReq({
          headers: withCsrf({ referer: 'https://evil.example.com/x' })
        })
      )
    ).toBe('非法请求来源')
  })

  it('origin 优先于 referer: origin 非法即拒, 不看 referer', () => {
    expect(
      verifyKunCsrf(
        makeReq({
          headers: withCsrf({
            origin: 'https://evil.example.com',
            referer: `${DEV}/edit`
          })
        })
      )
    ).toBe('非法请求来源')
  })

  it('既无 origin 也无 referer 时拒绝', () => {
    expect(verifyKunCsrf(makeReq({ headers: withCsrf({}) }))).toBe(
      '非法请求来源'
    )
  })

  it('畸形 origin (无法解析为 URL) 拒绝', () => {
    expect(
      verifyKunCsrf(makeReq({ headers: withCsrf({ origin: 'not-a-url' }) }))
    ).toBe('非法请求来源')
  })
})

// 对抗最初的疑点: 若模块加载时 env 不可用, ALLOWED_HOSTS 为空,
// 必须 fail-closed (拒绝) 而非 fail-open。用空 env 重载新实例来验证 ——
// 需 resetModules 也正是本次"模块级求值"改动引入的可测试性代价。
describe('verifyKunCsrf: env 缺失时 fail-closed', () => {
  it('未配置任何允许来源时, 结构合法的写请求仍被拒绝', async () => {
    vi.resetModules()
    vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV', '')
    vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD', '')
    const mod = await import('~/middleware/_csrf')
    const req = {
      method: 'POST',
      nextUrl: { pathname: '/api/foo' },
      headers: {
        get: (key: string) =>
          ({
            'x-requested-with': 'kun-fetch',
            origin: DEV
          })[key.toLowerCase()] ?? null
      }
    } as unknown as NextRequest
    expect(mod.verifyKunCsrf(req)).toBe('服务端未配置允许的请求来源')
  })
})
