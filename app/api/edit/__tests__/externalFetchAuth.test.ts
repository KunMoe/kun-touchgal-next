import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { verifyHeaderCookieMock, fetchMock, abuseGateMock } = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  fetchMock: vi.fn(),
  abuseGateMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// 不 mock 的话会去连真实 Redis (连上就写计数, 连不上就放行)
vi.mock('~/server/abuse/budget', () => ({ kunAbuseGate: abuseGateMock }))

import { POST as steamPost } from '../steam/route'
import { POST as dlsitePost } from '../dlsite/route'
import { POST as vndbRelationPost } from '../vndb/relation/route'
import { POST as vndbDetailsPost } from '../vndb/details/route'
import { POST as bangumiPost } from '../bangumi/route'

const request = (path: string, body: Record<string, string>) =>
  new NextRequest(`http://localhost/api/edit/${path}`, {
    method: 'POST',
    body: JSON.stringify(body)
  })

const routes: Array<{
  path: string
  post: (req: NextRequest) => Promise<Response>
  body: Record<string, string>
  upstream: string
}> = [
  {
    path: 'steam',
    post: steamPost,
    body: { steamId: '123' },
    upstream: 'upstream.steam'
  },
  {
    path: 'dlsite',
    post: dlsitePost,
    body: { code: 'RJ123456' },
    upstream: 'upstream.dlsite'
  },
  {
    path: 'vndb/relation',
    post: vndbRelationPost,
    body: { relationId: 'r123' },
    upstream: 'upstream.vndb'
  },
  {
    path: 'vndb/details',
    post: vndbDetailsPost,
    body: { vndbId: 'v123' },
    upstream: 'upstream.vndb'
  },
  {
    path: 'bangumi',
    post: bangumiPost,
    body: { bangumiId: '123' },
    upstream: 'upstream.bangumi'
  }
]

// 这五条路由是站点对 VNDB/Bangumi/Steam/DLsite 的出站抓取口,
// 鉴权闸门是防开放代理的唯一防线 (proxy 层 CSRF 头可被 curl 伪造)
describe('外部元数据抓取路由鉴权', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    abuseGateMock.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  for (const route of routes) {
    it(`未登录请求 ${route.path} 被拒且不触发出站抓取`, async () => {
      verifyHeaderCookieMock.mockResolvedValue(null)

      const res = await route.post(request(route.path, route.body))

      expect(await res.json()).toBe('用户未登录')
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it(`登录请求 ${route.path} 通过闸门且出站带超时 signal`, async () => {
      verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 1 })
      fetchMock.mockRejectedValue(new Error('network down'))

      const res = await route.post(request(route.path, route.body))

      expect(await res.json()).not.toBe('用户未登录')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
    })

    // 只限频, 不加角色门槛 (external-fetch-routes-auth-timeout 的裁定)
    it(`登录请求 ${route.path} 按账号与 ${route.upstream} 的整站配额扣, 超限时不出站`, async () => {
      const user = { uid: 1, role: 1 }
      verifyHeaderCookieMock.mockResolvedValue(user)
      abuseGateMock.mockResolvedValue('操作过于频繁, 请 5 分钟后再试')

      const res = await route.post(request(route.path, route.body))

      expect(await res.json()).toBe('操作过于频繁, 请 5 分钟后再试')
      expect(abuseGateMock).toHaveBeenCalledExactlyOnceWith(
        ['external.fetch', route.upstream],
        user
      )
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }
})
