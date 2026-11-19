import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import type Provider from 'oidc-provider'
import type { Server } from 'node:http'

// 依赖方发起的登出在真实 oidc-provider 上跑一遍, 看站点会话有没有跟着退出

const {
  verifyKunTokenWithUserMock,
  deleteKunTokenSessionMock,
  hasPendingResourceMock
} = vi.hoisted(() => ({
  verifyKunTokenWithUserMock: vi.fn(),
  deleteKunTokenSessionMock: vi.fn(),
  hasPendingResourceMock: vi.fn()
}))

// 站点 cookie 'site-<uid>' 当作 uid 的会话令牌 (登出只验签名, 不经 Redis 解析)
vi.mock('~/server/auth/session', () => ({
  verifyKunTokenWithUser: verifyKunTokenWithUserMock,
  deleteKunTokenSession: deleteKunTokenSessionMock,
  decodeKunSessionToken: (token: string) => {
    const uid = Number(token.replace('site-', ''))
    return Number.isInteger(uid) ? { uid, jti: `jti-${uid}` } : null
  }
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  hasPendingResource: hasPendingResourceMock
}))

import { buildKunInteractionPolicy } from '~/lib/oidc/policy'
import { registerKunSiteLogout } from '~/lib/oidc/siteLogout'
import {
  authorizeUrl,
  buildProvider,
  follow,
  loginOnce,
  rpLogout,
  send,
  siteSessionResolver,
  startServer,
  TOKEN_COOKIE,
  CLIENT_ID,
  type Browser
} from './_providerHarness'

const accounts = new Set<string>()
const siteSessions = new Set<number>()

const clearsSiteCookie = (res: Response) =>
  res.headers
    .getSetCookie()
    .some(
      (raw) =>
        raw.startsWith(`${TOKEN_COOKIE}=;`) &&
        /Path=\//.test(raw) &&
        /Max-Age=0/.test(raw)
    )

describe('依赖方登出 × 站点会话', () => {
  let provider: Provider
  let server: Server
  let base: string
  const browser = (): Browser => ({ base, jar: new Map() })

  beforeAll(async () => {
    provider = buildProvider(
      buildKunInteractionPolicy(),
      accounts,
      registerKunSiteLogout
    )
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
    verifyKunTokenWithUserMock.mockImplementation(
      siteSessionResolver(siteSessions)
    )
    deleteKunTokenSessionMock.mockResolvedValue(true)
  })

  it('同一个账号点「是」: 吊销这个浏览器的站点会话并清掉站点 cookie', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)

    const res = await rpLogout(b, 7, 'yes')

    expect(res.status).toBe(303)
    expect(deleteKunTokenSessionMock).toHaveBeenCalledTimes(1)
    expect(deleteKunTokenSessionMock).toHaveBeenCalledWith(7, 'jti-7')
    expect(clearsSiteCookie(res)).toBe(true)
  })

  it('吊销失败时照样清 cookie, 登出不报错', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)
    deleteKunTokenSessionMock.mockRejectedValue(new Error('redis down'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await rpLogout(b, 7, 'yes')

    expect(res.status).toBe(303)
    expect(clearsSiteCookie(res)).toBe(true)
    consoleError.mockRestore()
  })

  it('确认失败 (xsrf 不对) 时 provider 会话还在, 站点也不退', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)
    await send(b, `/session/end?client_id=${CLIENT_ID}`, 7)

    const res = await send(b, '/session/end/confirm', 7, {
      method: 'POST',
      body: new URLSearchParams({ xsrf: 'wrong', logout: 'yes' }).toString()
    })

    expect(res.status).toBe(400)
    expect(deleteKunTokenSessionMock).not.toHaveBeenCalled()
    expect(clearsSiteCookie(res)).toBe(false)
    // provider 会话仍在: 再授权零交互
    expect((await follow(b, authorizeUrl(), 7, provider)).kind).toBe('code')
  })

  it('Redis 不可用 (站点会话解析失败) 时照样按 cookie 的签名退出站点', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)
    verifyKunTokenWithUserMock.mockRejectedValue(new Error('redis down'))
    deleteKunTokenSessionMock.mockRejectedValue(new Error('redis down'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await rpLogout(b, 7, 'yes')

    expect(res.status).toBe(303)
    expect(clearsSiteCookie(res)).toBe(true)
    consoleError.mockRestore()
  })

  it('点「否」(只撤这个依赖方的授权) 时站点会话不动', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)

    const res = await rpLogout(b, 7, 'no')

    expect(res.status).toBe(303)
    expect(deleteKunTokenSessionMock).not.toHaveBeenCalled()
    expect(clearsSiteCookie(res)).toBe(false)
  })

  it('站点 cookie 已是另一个账号时不退站点', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)

    const res = await rpLogout(b, 8, 'yes')

    expect(res.status).toBe(303)
    expect(deleteKunTokenSessionMock).not.toHaveBeenCalled()
    expect(clearsSiteCookie(res)).toBe(false)
  })

  it('没有站点 cookie 时只登出 provider 会话', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)

    const res = await rpLogout(b, undefined, 'yes')

    expect(res.status).toBe(303)
    expect(deleteKunTokenSessionMock).not.toHaveBeenCalled()
  })

  it('换号流程经过的 end_session_confirm 不会把新登录的站点会话踢掉', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)
    const responses: Response[] = []
    const visited: string[] = []

    const outcome = await follow(b, authorizeUrl(), 8, provider)
    expect(outcome.kind).toBe('interaction')
    if (outcome.kind !== 'interaction') {
      return
    }
    const done = await follow(
      b,
      `/interaction/${outcome.uid}/login?as=8`,
      8,
      provider,
      (res, url) => {
        responses.push(res)
        visited.push(url)
      }
    )

    expect(done).toEqual({ kind: 'code', sub: '8' })
    // 途中确实经过了上游自动提交的登出确认 (登出旧账号 7 的 provider 会话)
    expect(visited).toContain('/session/end/confirm')
    expect(deleteKunTokenSessionMock).not.toHaveBeenCalled()
    expect(responses.some(clearsSiteCookie)).toBe(false)
  })

  it('登出之后同一个浏览器再授权要重新走登录交互', async () => {
    const b = browser()
    await loginOnce(b, provider, 7)
    await rpLogout(b, 7, 'yes')
    siteSessions.delete(7)

    expect((await follow(b, authorizeUrl(), undefined, provider)).kind).toBe(
      'interaction'
    )
  })
})
