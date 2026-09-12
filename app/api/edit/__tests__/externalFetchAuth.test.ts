import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { verifyHeaderCookieMock, fetchMock } = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  fetchMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

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
}> = [
  { path: 'steam', post: steamPost, body: { steamId: '123' } },
  { path: 'dlsite', post: dlsitePost, body: { code: 'RJ123456' } },
  {
    path: 'vndb/relation',
    post: vndbRelationPost,
    body: { relationId: 'r123' }
  },
  { path: 'vndb/details', post: vndbDetailsPost, body: { vndbId: 'v123' } },
  { path: 'bangumi', post: bangumiPost, body: { bangumiId: '123' } }
]

// 这五条路由是站点对 VNDB/Bangumi/Steam/DLsite 的出站抓取口,
// 鉴权闸门是防开放代理的唯一防线 (proxy 层 CSRF 头可被 curl 伪造)
describe('外部元数据抓取路由鉴权', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', fetchMock)
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
  }
})
