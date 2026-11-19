import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import Provider, { interactionPolicy } from 'oidc-provider'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { JWK, KoaContextWithOIDC } from 'oidc-provider'

// 用真实的 oidc-provider (内存 adapter) 跑授权端点, 只把站点会话解析换成可控的假件:
// 站点 cookie 里的 token 是 'site-<uid>', 对应会话由 siteSessions 决定

const { verifyKunTokenWithUserMock, hasPendingResourceMock, siteSessions } =
  vi.hoisted(() => ({
    verifyKunTokenWithUserMock: vi.fn(),
    hasPendingResourceMock: vi.fn(),
    siteSessions: new Set<number>()
  }))

vi.mock('~/app/api/utils/jwt', () => ({
  verifyKunTokenWithUser: verifyKunTokenWithUserMock
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  hasPendingResource: hasPendingResourceMock
}))

import { buildKunInteractionPolicy } from '~/lib/oidc/policy'

const TOKEN_COOKIE = 'kun-galgame-patch-moe-token'
const CLIENT_ID = 'rp'
const REDIRECT_URI = 'https://rp.example/cb'

// findAccount 认这个集合里的账号; 删掉即模拟封禁或删号
const accounts = new Set<string>()

const signingKey = generateKeyPairSync('rsa', {
  modulusLength: 2048
}).privateKey.export({ format: 'jwk' }) as JWK

const buildProvider = (policy: interactionPolicy.DefaultPolicy) => {
  const provider = new Provider('http://127.0.0.1/', {
    clients: [
      {
        client_id: CLIENT_ID,
        client_secret: 'secret',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code'],
        response_types: ['code']
      }
    ],
    jwks: { keys: [signingKey] },
    cookies: { keys: ['test-cookie-key'] },
    pkce: { required: () => false },
    features: { devInteractions: { enabled: false } },
    interactions: {
      policy,
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`
    },
    findAccount: (_ctx, id) =>
      accounts.has(id)
        ? { accountId: id, claims: () => ({ sub: id }) }
        : undefined,
    // 免同意 (同站内的一方应用): 无既有 grant 时直接授予请求的 scope
    async loadExistingGrant(ctx: KoaContextWithOIDC) {
      const { client, session } = ctx.oidc
      if (!client || !session?.accountId) {
        return undefined
      }
      const grantId =
        ctx.oidc.result?.consent?.grantId ?? session.grantIdFor(client.clientId)
      if (grantId) {
        return ctx.oidc.provider.Grant.find(grantId)
      }
      const grant = new ctx.oidc.provider.Grant({
        clientId: client.clientId,
        accountId: session.accountId
      })
      grant.addOIDCScope('openid')
      await grant.save()
      return grant
    }
  })

  // 模拟站点的交互页与 confirm: GET 回交互详情, /login?as=<uid> 以该账号完成 login 交互
  provider.use(async (ctx, next) => {
    const match = /^\/interaction\/([^/]+)(\/login)?$/.exec(ctx.path)
    if (!match) {
      return next()
    }
    if (match[2]) {
      ctx.respond = false
      await provider.interactionFinished(ctx.req, ctx.res, {
        login: { accountId: String(ctx.query.as) }
      })
      return
    }
    const details = await provider.interactionDetails(ctx.req, ctx.res)
    ctx.body = { prompt: details.prompt }
  })
  return provider
}

interface Browser {
  base: string
  jar: Map<string, string>
}

const cookieHeader = (browser: Browser, site?: number) =>
  [
    ...[...browser.jar.entries()].map(([k, v]) => `${k}=${v}`),
    ...(site === undefined ? [] : [`${TOKEN_COOKIE}=site-${site}`])
  ].join('; ')

const send = async (
  browser: Browser,
  url: string,
  site: number | undefined,
  init: { method?: string; body?: string } = {}
) => {
  const res = await fetch(new URL(url, browser.base), {
    method: init.method ?? 'GET',
    body: init.body,
    headers: {
      cookie: cookieHeader(browser, site),
      ...(init.body
        ? { 'content-type': 'application/x-www-form-urlencoded' }
        : {})
    },
    redirect: 'manual'
  })
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const index = pair.indexOf('=')
    const name = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()
    if (!value || /expires=Thu, 01 Jan 1970/i.test(raw)) {
      browser.jar.delete(name)
    } else {
      browser.jar.set(name, value)
    }
  }
  return res
}

type Outcome =
  | { kind: 'code'; sub: string }
  | { kind: 'error'; error: string }
  | { kind: 'interaction'; uid: string; reasons: string[] }
  | { kind: 'status'; status: number }

// 跟着 303 走, 遇到上游的自动提交表单 (换号时的 end_session_confirm) 就照着提交,
// 直到落到依赖方的 redirect_uri、交互页或一个非跳转的响应
const follow = async (
  browser: Browser,
  start: string,
  site: number | undefined,
  provider: Provider
): Promise<Outcome> => {
  let url = start
  let init: { method?: string; body?: string } = {}
  for (let i = 0; i < 12; i++) {
    const res = await send(browser, url, site, init)
    init = {}
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, new URL(url, browser.base))
      if (next.href.startsWith(REDIRECT_URI)) {
        const error = next.searchParams.get('error')
        if (error) {
          return { kind: 'error', error }
        }
        return {
          kind: 'code',
          sub: await subOfCode(provider, next.searchParams.get('code') ?? '')
        }
      }
      url = next.pathname + next.search
      continue
    }
    if (res.status === 200 && url.startsWith('/interaction/')) {
      const { prompt } = (await res.json()) as {
        prompt: { name: string; reasons: string[] }
      }
      expect(prompt.name).toBe('login')
      return {
        kind: 'interaction',
        uid: url.split('/')[2],
        reasons: prompt.reasons
      }
    }
    const text = await res.text()
    const form = /<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/.exec(text)
    if (res.status === 200 && form) {
      const fields = [...form[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)]
      url = new URL(form[1]).pathname
      init = {
        method: 'POST',
        body: new URLSearchParams(fields.map(([, k, v]) => [k, v])).toString()
      }
      continue
    }
    return { kind: 'status', status: res.status }
  }
  throw new Error('跳转次数过多')
}

// 读出授权码属于哪个账号 (内存 adapter 里存着它的 accountId)
const subOfCode = async (provider: Provider, code: string) => {
  const stored = await provider.AuthorizationCode.find(code)
  return stored?.accountId ?? '<none>'
}

const authorizeUrl = (extra = '') =>
  `/auth?client_id=${CLIENT_ID}&response_type=code&scope=openid` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}${extra}`

const startServer = async (provider: Provider) => {
  const server = createServer(provider.callback())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}` }
}

// 以账号 uid 走完一次授权 (第一次需要 login 交互), 在浏览器里留下 provider 会话
const loginOnce = async (browser: Browser, provider: Provider, uid: number) => {
  const first = await follow(browser, authorizeUrl(), uid, provider)
  expect(first.kind).toBe('interaction')
  if (first.kind !== 'interaction') {
    return
  }
  const done = await follow(
    browser,
    `/interaction/${first.uid}/login?as=${uid}`,
    uid,
    provider
  )
  expect(done).toEqual({ kind: 'code', sub: String(uid) })
}

describe.each([
  ['站点会话检查', () => buildKunInteractionPolicy(), true],
  ['对照: 上游默认策略', () => interactionPolicy.base(), false]
])('%s × 真实 oidc-provider', (_label, makePolicy, guarded) => {
  let provider: Provider
  let server: Server
  let base: string
  const browser = (): Browser => ({ base, jar: new Map() })

  beforeAll(async () => {
    provider = buildProvider(makePolicy())
    ;({ server, base } = await startServer(provider))
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    vi.resetAllMocks()
    accounts.clear()
    accounts.add('7')
    accounts.add('8')
    siteSessions.clear()
    siteSessions.add(7)
    siteSessions.add(8)
    verifyKunTokenWithUserMock.mockImplementation(async (token: string) => {
      const uid = Number(token.replace('site-', ''))
      return siteSessions.has(uid)
        ? {
            payload: { iss: '', aud: '', jti: 'j', uid, name: 'u', role: 1 },
            user: {
              id: uid,
              name: 'u',
              role: 1,
              status: 0,
              blocked_tag_ids: []
            }
          }
        : null
    })
  })

  it('两边同一个账号时零交互签发该账号的 code', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)

    expect(await follow(b, authorizeUrl(), 7, provider)).toEqual({
      kind: 'code',
      sub: '7'
    })
  })

  it('共享设备: 站点换成另一个账号后不再签发上一个人的 code', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)

    const outcome = await follow(b, authorizeUrl(), 8, provider)

    if (!guarded) {
      // 上游只看 provider 自己的会话: 站点已是 8, 依赖方拿到的仍是 7
      expect(outcome).toEqual({ kind: 'code', sub: '7' })
      return
    }
    expect(outcome).toMatchObject({
      kind: 'interaction',
      reasons: ['site_session_mismatch']
    })
    if (outcome.kind !== 'interaction') {
      return
    }
    // confirm 以站点账号 8 完成交互; 上游发现换号, 先登出 7 的 provider 会话再签发
    expect(
      await follow(b, `/interaction/${outcome.uid}/login?as=8`, 8, provider)
    ).toEqual({ kind: 'code', sub: '8' })
    expect(await follow(b, authorizeUrl(), 8, provider)).toEqual({
      kind: 'code',
      sub: '8'
    })
  })

  it('站点登出后 prompt=none 收到 login_required', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)
    siteSessions.delete(7)

    const outcome = await follow(b, authorizeUrl('&prompt=none'), 7, provider)

    expect(outcome).toEqual(
      guarded
        ? { kind: 'error', error: 'login_required' }
        : { kind: 'code', sub: '7' }
    )
  })

  it('站点 cookie 不在了 (站点登出) 时不零交互恢复', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)

    const outcome = await follow(b, authorizeUrl(), undefined, provider)

    expect(outcome.kind).toBe(guarded ? 'interaction' : 'code')
  })

  it.each([
    ['站点会话随之失效', true],
    // findAccount 与站点会话读的不是同一份数据 (鉴权缓存), 判定不能依赖两边同时生效
    ['站点会话仍判为有效', false]
  ])(
    '账号被封禁或删除后进入登录交互, 而不是 500 (%s)',
    async (_label, siteRevoked) => {
      const b = browser()
      await loginOnce(b, provider, 7)
      accounts.delete('7')
      if (siteRevoked) {
        siteSessions.delete(7)
      }

      const outcome = await follow(b, authorizeUrl(), 7, provider)

      if (!guarded) {
        // consent 的检查读 undefined 的 grant 抛 TypeError
        expect(outcome).toEqual({ kind: 'status', status: 500 })
        return
      }
      expect(outcome).toMatchObject({ kind: 'interaction' })
    }
  )
})
