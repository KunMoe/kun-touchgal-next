import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errors } from 'oidc-provider'

const {
  verifyHeaderCookieMock,
  getOidcProviderMock,
  buildRequestBridgeMock,
  interactionFinishedMock,
  interactionDetailsMock,
  grantFindMock,
  grantSaveMock,
  grantAddOIDCScopeMock,
  grantAddOIDCClaimsMock,
  grantAddResourceScopeMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  getOidcProviderMock: vi.fn(),
  buildRequestBridgeMock: vi.fn(),
  interactionFinishedMock: vi.fn(),
  interactionDetailsMock: vi.fn(),
  grantFindMock: vi.fn(),
  grantSaveMock: vi.fn(),
  grantAddOIDCScopeMock: vi.fn(),
  grantAddOIDCClaimsMock: vi.fn(),
  grantAddResourceScopeMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), init),
    redirect: (url: URL | string, status?: number) =>
      new Response(null, {
        status: status ?? 307,
        headers: { location: String(url) }
      })
  }
}))

vi.mock('~/lib/oidc/provider', () => ({
  getOidcProvider: getOidcProviderMock
}))

vi.mock('~/lib/oidc/webToNode', () => ({
  buildRequestBridge: buildRequestBridgeMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

import { GET, POST } from '~/app/oidc/interaction/[uid]/confirm/route'

class GrantMock {
  static find = grantFindMock
  addOIDCScope = grantAddOIDCScopeMock
  addOIDCClaims = grantAddOIDCClaimsMock
  addResourceScope = grantAddResourceScopeMock
  save = grantSaveMock

  constructor(public initArgs: unknown) {}
}

const confirmUrl = 'http://localhost/oidc/interaction/uid123/confirm'
const interactionUrl = 'http://localhost/oidc/interaction/uid123'
const resumeUrl = 'http://localhost/oidc/auth/uid123'

const createBridge = () => ({
  req: { push: vi.fn() },
  res: {},
  bodyBuffer: null,
  toResponse: () =>
    new Response(null, { status: 303, headers: { location: resumeUrl } })
})

const routeContext = () => ({ params: Promise.resolve({ uid: 'uid123' }) })

// 时间轴 (秒): 站点登录 → 交互创建 → 此刻
const SITE_LOGIN_IAT = 1_700_000_000
const INTERACTION_IAT = SITE_LOGIN_IAT + 3600
const NOW = INTERACTION_IAT + 10

const loginDetails = (
  reasons: string[],
  details: Record<string, unknown> = {}
) => ({
  iat: INTERACTION_IAT,
  prompt: { name: 'login', reasons, details },
  params: { client_id: 'client-1' }
})

const getRequest = (url = confirmUrl) =>
  new Request(url) as unknown as Parameters<typeof GET>[0]

const postRequest = (url = confirmUrl) =>
  new Request(url, { method: 'POST' }) as unknown as Parameters<typeof POST>[0]

describe('OIDC confirm route GET', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getOidcProviderMock.mockReturnValue({
      interactionFinished: interactionFinishedMock,
      interactionDetails: interactionDetailsMock,
      Grant: GrantMock
    })
    buildRequestBridgeMock.mockResolvedValue(createBridge())
    // 交互创建于 INTERACTION_IAT, 只因为 provider 会话缺失而要登录
    interactionDetailsMock.mockResolvedValue(loginDetails(['no_session']))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW * 1000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('未登录时重定向到登录页并携带 from', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    const res = await GET(getRequest(), routeContext())

    expect(res.headers.get('location')).toBe(
      'http://localhost/login?from=%2Foidc%2Finteraction%2Fuid123'
    )
    expect(interactionFinishedMock).not.toHaveBeenCalled()
  })

  it('已登录时以 accountId 与站点登录时刻完成 login 交互并透传 303', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7, iat: SITE_LOGIN_IAT })
    interactionFinishedMock.mockResolvedValue(undefined)

    const res = await GET(getRequest(), routeContext())

    expect(interactionFinishedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { login: { accountId: '7', ts: SITE_LOGIN_IAT } }
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(resumeUrl)
  })

  it('令牌带 auth_time 时以它为认证时刻 (重签过的令牌 iat 比登录晚)', async () => {
    verifyHeaderCookieMock.mockResolvedValue({
      uid: 7,
      auth_time: SITE_LOGIN_IAT,
      iat: INTERACTION_IAT + 5
    })
    interactionDetailsMock.mockResolvedValue(loginDetails(['login_prompt']))

    const res = await GET(getRequest(), routeContext())

    // 认证发生在交互开始之前: 即使令牌是交互之后重签的, prompt=login 也要重新登录
    expect(res.headers.get('location')).toBe(
      'http://localhost/login?from=%2Foidc%2Finteraction%2Fuid123'
    )
    expect(interactionFinishedMock).not.toHaveBeenCalled()
  })

  it('interaction 读不到时同样回落到 interaction 页', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7, iat: SITE_LOGIN_IAT })
    interactionDetailsMock.mockRejectedValue(
      new errors.SessionNotFound('interaction session not found')
    )

    const res = await GET(getRequest(), routeContext())

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(interactionUrl)
    expect(interactionFinishedMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      'prompt=login, 交互开始前登录的站点会话',
      ['login_prompt'],
      {},
      SITE_LOGIN_IAT
    ],
    [
      'max_age 已超出, 交互开始前登录的站点会话',
      ['max_age'],
      { max_age: 60 },
      SITE_LOGIN_IAT
    ]
  ])('%s: 转登录页重新登录', async (_label, reasons, details, iat) => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7, iat })
    interactionDetailsMock.mockResolvedValue(loginDetails(reasons, details))

    const res = await GET(getRequest(), routeContext())

    expect(res.headers.get('location')).toBe(
      'http://localhost/login?from=%2Foidc%2Finteraction%2Fuid123'
    )
    expect(interactionFinishedMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      'prompt=login, 交互开始后重新登录过',
      ['login_prompt'],
      {},
      INTERACTION_IAT
    ],
    [
      'max_age 已超出, 但交互开始后重新登录过',
      ['max_age'],
      { max_age: 0 },
      INTERACTION_IAT + 5
    ],
    [
      'max_age 之内的站点会话',
      ['max_age'],
      { max_age: NOW - SITE_LOGIN_IAT },
      SITE_LOGIN_IAT
    ]
  ])('%s: 直接完成 login 交互', async (_label, reasons, details, iat) => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7, iat })
    interactionDetailsMock.mockResolvedValue(loginDetails(reasons, details))
    interactionFinishedMock.mockResolvedValue(undefined)

    const res = await GET(getRequest(), routeContext())

    expect(interactionFinishedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { login: { accountId: '7', ts: iat } }
    )
    expect(res.status).toBe(303)
  })

  it('interaction 已被消费时回落到 interaction 页而非 500', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7 })
    interactionFinishedMock.mockRejectedValue(
      new errors.SessionNotFound('interaction session not found')
    )

    const res = await GET(getRequest(), routeContext())

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(interactionUrl)
  })

  it('非 SessionNotFound 错误继续抛出', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7 })
    interactionFinishedMock.mockRejectedValue(new Error('boom'))

    await expect(GET(getRequest(), routeContext())).rejects.toThrow('boom')
  })
})

describe('OIDC confirm route POST', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getOidcProviderMock.mockReturnValue({
      interactionFinished: interactionFinishedMock,
      interactionDetails: interactionDetailsMock,
      Grant: GrantMock
    })
    buildRequestBridgeMock.mockResolvedValue(createBridge())
    // 站点会话与 SSO 会话是同一个账号
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7 })
  })

  it('interaction 已被消费时回落到 interaction 页而非 500', async () => {
    interactionDetailsMock.mockRejectedValue(
      new errors.SessionNotFound('interaction session not found')
    )

    const res = await POST(postRequest(), routeContext())

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(interactionUrl)
    expect(interactionFinishedMock).not.toHaveBeenCalled()
  })

  it('同意授权时创建 Grant 并以 grantId 完成 consent 交互', async () => {
    interactionDetailsMock.mockResolvedValue({
      session: { accountId: '7' },
      grantId: undefined,
      prompt: {
        details: {
          missingOIDCScope: ['openid', 'profile'],
          missingOIDCClaims: ['email'],
          missingResourceScopes: { 'urn:api': ['read', 'write'] }
        }
      },
      params: { client_id: 'client-1' }
    })
    grantSaveMock.mockResolvedValue('grant-new-1')
    interactionFinishedMock.mockResolvedValue(undefined)

    const res = await POST(postRequest(), routeContext())

    expect(grantAddOIDCScopeMock).toHaveBeenCalledWith('openid profile')
    expect(grantAddOIDCClaimsMock).toHaveBeenCalledWith(['email'])
    expect(grantAddResourceScopeMock).toHaveBeenCalledWith(
      'urn:api',
      'read write'
    )
    expect(interactionFinishedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { consent: { grantId: 'grant-new-1' } },
      { mergeWithLastSubmission: true }
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(resumeUrl)
  })

  it('取消授权时以 access_denied 完成交互', async () => {
    interactionDetailsMock.mockResolvedValue({
      session: { accountId: '7' },
      grantId: undefined,
      prompt: { details: {} },
      params: { client_id: 'client-1' }
    })

    const res = await POST(
      postRequest(`${confirmUrl}?error=access_denied`),
      routeContext()
    )

    expect(interactionFinishedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ error: 'access_denied' })
    )
    expect(grantSaveMock).not.toHaveBeenCalled()
    expect(res.status).toBe(303)
  })

  it.each([
    ['站点已登出', null],
    ['站点换成了另一个账号', { uid: 8 }]
  ])('%s时不建 Grant, 以 login_required 结束交互', async (_label, viewer) => {
    verifyHeaderCookieMock.mockResolvedValue(viewer)
    interactionDetailsMock.mockResolvedValue({
      session: { accountId: '7' },
      grantId: undefined,
      prompt: { details: { missingOIDCScope: ['openid'] } },
      params: { client_id: 'client-1' }
    })
    interactionFinishedMock.mockResolvedValue(undefined)

    const res = await POST(postRequest(), routeContext())

    expect(grantSaveMock).not.toHaveBeenCalled()
    expect(grantFindMock).not.toHaveBeenCalled()
    expect(interactionFinishedMock).toHaveBeenCalledTimes(1)
    expect(interactionFinishedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ error: 'login_required' })
    )
    expect(res.status).toBe(303)
  })
})
