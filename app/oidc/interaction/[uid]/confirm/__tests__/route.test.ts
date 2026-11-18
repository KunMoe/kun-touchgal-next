import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  })

  it('未登录时重定向到登录页并携带 from', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)

    const res = await GET(getRequest(), routeContext())

    expect(res.headers.get('location')).toBe(
      'http://localhost/login?from=%2Foidc%2Finteraction%2Fuid123'
    )
    expect(interactionFinishedMock).not.toHaveBeenCalled()
  })

  it('已登录时以 accountId 完成 login 交互并透传 303', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 7 })
    interactionFinishedMock.mockResolvedValue(undefined)

    const res = await GET(getRequest(), routeContext())

    expect(interactionFinishedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { login: { accountId: '7' } }
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(resumeUrl)
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
      session: { accountId: 'acc-1' },
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
      session: { accountId: 'acc-1' },
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
})
