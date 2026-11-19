import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KoaContextWithOIDC } from 'oidc-provider'

const { verifyKunTokenWithUserMock, hasPendingResourceMock } = vi.hoisted(
  () => ({
    verifyKunTokenWithUserMock: vi.fn(),
    hasPendingResourceMock: vi.fn()
  })
)

vi.mock('~/server/auth/session', () => ({
  verifyKunTokenWithUser: verifyKunTokenWithUserMock
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  hasPendingResource: hasPendingResourceMock
}))

import {
  buildKunInteractionPolicy,
  checkSiteSession,
  SITE_SESSION_CHECK_REASON
} from '~/lib/oidc/policy'

const TOKEN_COOKIE = 'kun-galgame-patch-moe-token'

const sessionOf = (uid: number) => ({
  payload: { iss: '', aud: '', jti: 'j', uid, name: 'kun', role: 1 },
  user: { id: uid, name: 'kun', role: 1, status: 0, blocked_tag_ids: [] }
})

interface FakeCtxInput {
  accountId?: string
  account?: boolean
  resumedLogin?: boolean
  cookie?: string
}

const fakeCtx = ({
  accountId,
  account = true,
  resumedLogin = false,
  cookie = ''
}: FakeCtxInput) =>
  ({
    get: (name: string) => (name.toLowerCase() === 'cookie' ? cookie : ''),
    oidc: {
      session: { accountId },
      account: account && accountId ? { accountId } : undefined,
      result: resumedLogin ? { login: { accountId } } : undefined
    }
  }) as unknown as KoaContextWithOIDC

describe('checkSiteSession', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('没有 provider 会话时不拦, 交给上游 no_session', async () => {
    expect(await checkSiteSession(fakeCtx({}))).toBe(false)
    expect(verifyKunTokenWithUserMock).not.toHaveBeenCalled()
  })

  it('provider 会话的账号载不到 (封禁 / 删号) 时要求登录, 不读站点会话', async () => {
    const ctx = fakeCtx({
      accountId: '7',
      account: false,
      cookie: `${TOKEN_COOKIE}=good`
    })

    expect(await checkSiteSession(ctx)).toBe(true)
    expect(verifyKunTokenWithUserMock).not.toHaveBeenCalled()
  })

  it('账号载不到时即使正处在 login 交互的回跳里也要求登录', async () => {
    const ctx = fakeCtx({ accountId: '7', account: false, resumedLogin: true })

    expect(await checkSiteSession(ctx)).toBe(true)
  })

  it('刚完成 login 交互回到授权端点时不再复判', async () => {
    const ctx = fakeCtx({ accountId: '7', resumedLogin: true })

    expect(await checkSiteSession(ctx)).toBe(false)
    expect(verifyKunTokenWithUserMock).not.toHaveBeenCalled()
  })

  it('请求不带站点 cookie (站点已登出) 时要求登录', async () => {
    expect(await checkSiteSession(fakeCtx({ accountId: '7' }))).toBe(true)
    expect(verifyKunTokenWithUserMock).not.toHaveBeenCalled()
  })

  it('站点会话失效 (被吊销或过期) 时要求登录', async () => {
    verifyKunTokenWithUserMock.mockResolvedValue(null)

    const ctx = fakeCtx({ accountId: '7', cookie: `${TOKEN_COOKIE}=revoked` })

    expect(await checkSiteSession(ctx)).toBe(true)
    expect(verifyKunTokenWithUserMock).toHaveBeenCalledWith('revoked')
  })

  it('站点登录的是另一个账号 (共享设备换人) 时要求登录', async () => {
    verifyKunTokenWithUserMock.mockResolvedValue(sessionOf(8))

    const ctx = fakeCtx({ accountId: '7', cookie: `${TOKEN_COOKIE}=good` })

    expect(await checkSiteSession(ctx)).toBe(true)
  })

  it('站点会话解析出错时按未登录处理 (fail-closed)', async () => {
    verifyKunTokenWithUserMock.mockRejectedValue(new Error('redis down'))

    const ctx = fakeCtx({ accountId: '7', cookie: `${TOKEN_COOKIE}=good` })

    expect(await checkSiteSession(ctx)).toBe(true)
  })

  it('两边是同一个账号时不弹交互', async () => {
    verifyKunTokenWithUserMock.mockResolvedValue(sessionOf(7))

    const ctx = fakeCtx({
      accountId: '7',
      cookie: `other=1; ${TOKEN_COOKIE}=good`
    })

    expect(await checkSiteSession(ctx)).toBe(false)
    expect(verifyKunTokenWithUserMock).toHaveBeenCalledWith('good')
  })
})

describe('buildKunInteractionPolicy', () => {
  it('检查挂在 login prompt 上 (排在 consent 之前), 错误码是 login_required', () => {
    const policy = buildKunInteractionPolicy()

    expect(policy.map((prompt) => prompt.name)).toEqual(['login', 'consent'])
    const check = policy.get('login')?.checks.get(SITE_SESSION_CHECK_REASON)
    expect(check?.error).toBe('login_required')
    expect(check?.check).toBe(checkSiteSession)
  })

  it('上游默认的 login 检查原样保留', () => {
    const reasons = buildKunInteractionPolicy()
      .get('login')
      ?.checks.map((check) => check.reason)

    expect(reasons).toEqual([
      'login_prompt',
      'no_session',
      'max_age',
      'id_token_hint',
      'claims_id_token_sub_value',
      'essential_acrs',
      'essential_acr',
      SITE_SESSION_CHECK_REASON
    ])
  })
})
