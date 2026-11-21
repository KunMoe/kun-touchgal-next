import { describe, expect, it, vi } from 'vitest'

const { kunGetSitemapMock } = vi.hoisted(() => ({
  kunGetSitemapMock: vi.fn()
}))

vi.mock('~/server/sitemap/load', () => ({ kunGetSitemap: kunGetSitemapMock }))

import * as route from '~/app/sitemap'

describe('app/sitemap', () => {
  // 少了 force-dynamic 或换成 revalidate, next build 就会预渲染它: 构建时去查生产库,
  // 内容冻结在构建那一刻, 而库连得上时构建照样成功, 看不出来
  it('不在构建期预渲染', () => {
    expect(route.dynamic).toBe('force-dynamic')
    expect('revalidate' in route).toBe(false)
  })

  it('内容取自 kunGetSitemap', async () => {
    const sitemap = [{ url: 'https://www.touchgal.ink' }]
    kunGetSitemapMock.mockResolvedValue(sitemap)

    expect(await route.default()).toBe(sitemap)
  })
})
