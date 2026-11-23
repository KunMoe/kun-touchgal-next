import { generateKeyPairSync } from 'node:crypto'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Provider from 'oidc-provider'
import type { JWK } from 'oidc-provider'

// provider 输出的绝对地址 (discovery 端点、交互的 returnTo) 取自 Koa 的 ctx.href, 会话 cookie
// 带不带 Secure 取自 ctx.secure。这里断言二者只由 OIDC_ISSUER 决定: 请求自带的 Host 与
// X-Forwarded-* 到不了 provider, 边缘是否覆盖写这些头 (代码里看不出来) 不再影响结果

const { ISSUER, headersMock, cookiesMock, callbackRef } = vi.hoisted(() => ({
  ISSUER: 'https://auth.example.test/oidc',
  headersMock: vi.fn(),
  cookiesMock: vi.fn(),
  callbackRef: { current: null as unknown }
}))

vi.mock('~/config/oidc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/config/oidc')>()),
  OIDC_ISSUER: ISSUER
}))

vi.mock('~/lib/oidc/provider', () => ({
  getOidcCallback: () => callbackRef.current
}))

vi.mock('next/headers', () => ({
  headers: headersMock,
  cookies: cookiesMock
}))

import {
  buildHeadersBridge,
  buildRequestBridge,
  handleOidcCallback,
  normalizeOidcRequestView
} from '~/lib/oidc/webToNode'

const REDIRECT_URI = 'https://rp.example.test/cb'

// 客户端自带 (边缘没有覆盖写时会原样到达) 的一组头
const FORGED = {
  host: 'localhost:3000',
  'x-forwarded-host': 'evil.example',
  'x-forwarded-proto': 'http',
  'x-forwarded-port': '80',
  'x-forwarded-for': '203.0.113.9'
}

const signingKey = generateKeyPairSync('rsa', {
  modulusLength: 2048
}).privateKey.export({ format: 'jwk' }) as JWK

// 与 lib/oidc/provider.ts 一样不开 proxy
const provider = new Provider(ISSUER, {
  clients: [
    {
      client_id: 'rp',
      client_secret: 'secret',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code']
    }
  ],
  jwks: { keys: [signingKey] },
  cookies: { keys: ['test-cookie-key'] },
  pkce: { required: () => false },
  features: { devInteractions: { enabled: false } }
})

const nodeReq = (headers: Record<string, string>) => {
  const req = new IncomingMessage(new Socket())
  req.headers = { ...headers }
  return req
}

const encryptedOf = (req: IncomingMessage) =>
  (req.socket as Socket & { encrypted?: boolean }).encrypted

beforeEach(() => {
  callbackRef.current = provider.callback()
  headersMock.mockResolvedValue(
    new Headers({ ...FORGED, cookie: '_interaction=abc' })
  )
  cookiesMock.mockResolvedValue({ toString: () => '' })
})

describe('normalizeOidcRequestView', () => {
  it('https issuer: Host 取 issuer, 删转发头, 连接视为加密, 其余头不动', () => {
    const req = nodeReq({ ...FORGED, cookie: 'a=1', 'user-agent': 'ua' })
    normalizeOidcRequestView(req, new URL(ISSUER))
    expect(req.headers).toEqual({
      host: 'auth.example.test',
      cookie: 'a=1',
      'user-agent': 'ua'
    })
    expect(encryptedOf(req)).toBe(true)
  })

  it('http issuer (本地开发): 只改 Host, 连接不标成加密', () => {
    const req = nodeReq(FORGED)
    normalizeOidcRequestView(req, new URL('http://127.0.0.1:3000/oidc'))
    expect(req.headers).toEqual({ host: '127.0.0.1:3000' })
    expect(encryptedOf(req)).toBeFalsy()
  })
})

describe('两个桥都按 issuer 规范化', () => {
  it('buildRequestBridge: Koa 的 href / host / secure 取自 issuer', async () => {
    const request = new Request('http://localhost:3000/oidc/auth?x=1', {
      headers: FORGED
    })
    const { req, res } = await buildRequestBridge(request, true)
    expect(
      Object.keys(req.headers).filter((key) => key.startsWith('x-'))
    ).toEqual([])
    const ctx = provider.createContext(req, res)
    expect(ctx.host).toBe('auth.example.test')
    expect(ctx.secure).toBe(true)
    expect(ctx.href).toBe('https://auth.example.test/auth?x=1')
  })

  it('buildHeadersBridge: 同样不认请求自带的 Host 与转发头', async () => {
    const { req, res } = await buildHeadersBridge('/oidc/interaction/u1')
    expect(req.headers.cookie).toBe('_interaction=abc')
    expect(req.headers['x-forwarded-host']).toBeUndefined()
    const ctx = provider.createContext(req, res)
    expect(ctx.href).toBe('https://auth.example.test/oidc/interaction/u1')
    expect(ctx.secure).toBe(true)
  })

  it('remoteAddress 与应用的 getRemoteIp 同源, 取不到时回落 127.0.0.1', async () => {
    const withCf = await buildRequestBridge(
      new Request('http://localhost:3000/oidc/auth', {
        headers: { ...FORGED, 'cf-connecting-ip': '198.51.100.7' }
      }),
      true
    )
    expect(withCf.req.socket.remoteAddress).toBe('198.51.100.7')
    const bare = await buildRequestBridge(
      new Request('http://localhost:3000/oidc/auth'),
      true
    )
    expect(bare.req.socket.remoteAddress).toBe('127.0.0.1')
  })
})

describe('真实 provider 经桥', () => {
  it('discovery 的 issuer 与全部端点都在 issuer 之下', async () => {
    const res = await handleOidcCallback(
      new Request(
        'http://localhost:3000/oidc/.well-known/openid-configuration',
        { headers: FORGED }
      )
    )
    expect(res.status).toBe(200)
    const discovery = (await res.json()) as Record<string, unknown>
    expect(discovery.issuer).toBe(ISSUER)
    const endpoints = Object.entries(discovery).filter(
      ([key]) => key.endsWith('_endpoint') || key === 'jwks_uri'
    )
    expect(endpoints.length).toBeGreaterThan(3)
    for (const [key, value] of endpoints) {
      expect(String(value), key).toMatch(
        /^https:\/\/auth\.example\.test\/oidc\//
      )
    }
  })

  it('授权请求种下的交互 cookie 带 Secure', async () => {
    const query = new URLSearchParams({
      client_id: 'rp',
      response_type: 'code',
      scope: 'openid',
      redirect_uri: REDIRECT_URI
    })
    const res = await handleOidcCallback(
      new Request(`http://localhost:3000/oidc/auth?${query}`, {
        headers: FORGED
      })
    )
    expect(res.status).toBe(303)
    const cookies = res.headers.getSetCookie()
    expect(cookies.length).toBeGreaterThan(0)
    for (const cookie of cookies) {
      expect(cookie.toLowerCase(), cookie).toContain('; secure')
    }
  })
})
