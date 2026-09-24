import { describe, expect, it } from 'vitest'
import { buildCustomRoute } from 'next/dist/lib/build-custom-route'
import { matchHas } from 'next/dist/shared/lib/router/utils/prepare-destination'
import { kunRscCacheHeaders } from '~/config/rsc-cache-headers'
import type { IncomingMessage } from 'node:http'

// 用 Next 自己的匹配实现断言, 规则写法或 Next 语义变化都会在这里暴露
const [rule] = kunRscCacheHeaders
const regex = new RegExp(buildCustomRoute('header', rule).regex)
const applies = (headers: Record<string, string>) =>
  !!matchHas(
    { headers } as unknown as IncomingMessage,
    {},
    rule.has,
    rule.missing
  )

describe('游客 RSC 响应去掉 no-store 以放行 bfcache', () => {
  it('只有一条规则, 值不含 no-store', () => {
    expect(kunRscCacheHeaders).toHaveLength(1)
    expect(rule.headers).toEqual([
      { key: 'Cache-Control', value: 'private, no-cache' }
    ])
  })

  it.each([
    '/',
    '/galgame',
    '/f5511f9f',
    '/f5511f9f/resource/17049',
    '/redirect',
    '/tag/86076'
  ])('动态路由 %s 命中', (path) => {
    expect(regex.test(path)).toBe(true)
  })

  it.each(['/doc', '/doc/', '/doc/notice/faq'])(
    '静态预渲染 %s 不命中, 保留 s-maxage',
    (path) => {
      expect(regex.test(path)).toBe(false)
    }
  )

  it('游客 RSC 请求命中', () => {
    expect(applies({ rsc: '1' })).toBe(true)
    expect(applies({ rsc: '1', cookie: 'kun-patch-setting-store|x=1' })).toBe(
      true
    )
  })

  it('带登录 token 的 RSC 请求不命中, 私有载荷仍为 no-store', () => {
    expect(
      applies({ rsc: '1', cookie: 'a=1; kun-galgame-patch-moe-token=t' })
    ).toBe(false)
  })

  it('HTML 请求不命中, 主文档保持 no-store', () => {
    expect(applies({})).toBe(false)
  })
})
