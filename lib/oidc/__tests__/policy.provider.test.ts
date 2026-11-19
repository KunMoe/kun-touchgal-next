import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { interactionPolicy } from 'oidc-provider'
import type Provider from 'oidc-provider'
import type { Server } from 'node:http'

// 真实 oidc-provider 上跑授权端点, 站点会话换成可控的假件 (见 _providerHarness)

const { verifyKunTokenWithUserMock, hasPendingResourceMock } = vi.hoisted(
  () => ({
    verifyKunTokenWithUserMock: vi.fn(),
    hasPendingResourceMock: vi.fn()
  })
)

vi.mock('~/app/api/utils/jwt', () => ({
  verifyKunTokenWithUser: verifyKunTokenWithUserMock
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  hasPendingResource: hasPendingResourceMock
}))

import { buildKunInteractionPolicy } from '~/lib/oidc/policy'
import {
  authorizeUrl,
  buildProvider,
  follow,
  loginOnce,
  siteSessionResolver,
  startServer,
  type Browser
} from './_providerHarness'

// findAccount 认的账号与站点上有效的会话; 删掉即模拟封禁 / 删号、站点登出
const accounts = new Set<string>()
const siteSessions = new Set<number>()

describe.each([
  ['站点会话检查', () => buildKunInteractionPolicy(), true],
  ['对照: 上游默认策略', () => interactionPolicy.base(), false]
])('%s × 真实 oidc-provider', (_label, makePolicy, guarded) => {
  let provider: Provider
  let server: Server
  let base: string
  const browser = (): Browser => ({ base, jar: new Map() })

  beforeAll(async () => {
    provider = buildProvider(makePolicy(), accounts)
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
