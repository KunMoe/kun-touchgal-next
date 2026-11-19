import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { expect } from 'vitest'
import Provider from 'oidc-provider'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { interactionPolicy, JWK, KoaContextWithOIDC } from 'oidc-provider'

// 用真实的 oidc-provider (内存 adapter) 跑授权与登出端点。站点会话由各测试文件 mock:
// 站点 cookie 里的 token 写成 'site-<uid>'

export const TOKEN_COOKIE = 'kun-galgame-patch-moe-token'
export const CLIENT_ID = 'rp'
export const REDIRECT_URI = 'https://rp.example/cb'

const signingKey = generateKeyPairSync('rsa', {
  modulusLength: 2048
}).privateKey.export({ format: 'jwk' }) as JWK

// 站点 cookie 'site-<uid>' 对应的会话 (verifyKunTokenWithUser 的返回形状), 不在 live 里就是失效
export const siteSessionResolver =
  (live: Set<number>) => async (token: string) => {
    const uid = Number(token.replace('site-', ''))
    return live.has(uid)
      ? {
          payload: {
            iss: '',
            aud: '',
            jti: `jti-${uid}`,
            uid,
            name: 'u',
            role: 1
          },
          user: { id: uid, name: 'u', role: 1, status: 0, blocked_tag_ids: [] }
        }
      : null
  }

// accounts: findAccount 认的账号, 删掉即模拟封禁或删号
export const buildProvider = (
  policy: interactionPolicy.DefaultPolicy,
  accounts: Set<string>,
  setup: (provider: Provider) => void = () => {}
) => {
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
  setup(provider)

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

export const startServer = async (provider: Provider) => {
  const server: Server = createServer(provider.callback())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { server, base: `http://127.0.0.1:${port}` }
}

export interface Browser {
  base: string
  jar: Map<string, string>
}

const cookieHeader = (browser: Browser, site?: number) =>
  [
    ...[...browser.jar.entries()].map(([k, v]) => `${k}=${v}`),
    ...(site === undefined ? [] : [`${TOKEN_COOKIE}=site-${site}`])
  ].join('; ')

export const send = async (
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

export type Outcome =
  | { kind: 'code'; sub: string }
  | { kind: 'error'; error: string }
  | { kind: 'interaction'; uid: string; reasons: string[] }
  | { kind: 'status'; status: number }

// 读出授权码属于哪个账号 (内存 adapter 里存着它的 accountId)
const subOfCode = async (provider: Provider, code: string) => {
  const stored = await provider.AuthorizationCode.find(code)
  return stored?.accountId ?? '<none>'
}

// 跟着 303 走, 遇到上游的自动提交表单 (换号时的 end_session_confirm) 就照着提交,
// 直到落到依赖方的 redirect_uri、交互页或一个非跳转的响应。
// onResponse 能看到途中每个响应 (比如检查谁写了 Set-Cookie)
export const follow = async (
  browser: Browser,
  start: string,
  site: number | undefined,
  provider: Provider,
  onResponse: (res: Response, url: string) => void = () => {}
): Promise<Outcome> => {
  let url = start
  let init: { method?: string; body?: string } = {}
  for (let i = 0; i < 12; i++) {
    const res = await send(browser, url, site, init)
    onResponse(res, url)
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

export const authorizeUrl = (extra = '') =>
  `/auth?client_id=${CLIENT_ID}&response_type=code&scope=openid` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}${extra}`

// 以账号 uid 走完一次授权 (第一次需要 login 交互), 在浏览器里留下 provider 会话
export const loginOnce = async (
  browser: Browser,
  provider: Provider,
  uid: number
) => {
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

// 依赖方发起的登出: 打开上游的登出确认页, 点「是」(logout=yes) 或「否」, 返回确认请求的响应
export const rpLogout = async (
  browser: Browser,
  site: number | undefined,
  answer: 'yes' | 'no'
) => {
  const page = await send(browser, `/session/end?client_id=${CLIENT_ID}`, site)
  const xsrf = /name="xsrf" value="([^"]+)"/.exec(await page.text())?.[1]
  expect(xsrf).toBeTruthy()
  return send(browser, '/session/end/confirm', site, {
    method: 'POST',
    body: new URLSearchParams({
      xsrf: xsrf ?? '',
      ...(answer === 'yes' ? { logout: 'yes' } : {})
    }).toString()
  })
}
