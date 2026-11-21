import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SITEMAP_CACHE_DURATION } from '~/config/cache'
import { kunMoyuMoe } from '~/config/moyu-moe'
import {
  PUBLIC_VISIBILITY,
  toPatchWhere
} from '~/server/viewer/patchVisibility'

const { patchFindManyMock, companyFindManyMock, getAllPostsMock } = vi.hoisted(
  () => ({
    patchFindManyMock: vi.fn(),
    companyFindManyMock: vi.fn(),
    getAllPostsMock: vi.fn()
  })
)

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findMany: patchFindManyMock },
    patch_company: { findMany: companyFindManyMock }
  }
}))

vi.mock('~/lib/mdx/getPosts', () => ({ getAllPosts: getAllPostsMock }))

const origin = kunMoyuMoe.domain.main
const TTL_MS = SITEMAP_CACHE_DURATION * 1000
// 与 load.ts 的 LOAD_TIMEOUT_MS 相同; 那个常量不导出, 改它时这里跟着改
const LOAD_TIMEOUT_MS = 30 * 1000
const UPDATED = new Date('2026-11-20T08:00:00Z')

// 记忆是模块级状态: 每个用例重新加载模块, 拿到一份空的记忆
const loadKunGetSitemap = async () =>
  (await import('~/server/sitemap/load')).kunGetSitemap

const urlsOf = (sitemap: { url: string }[]) => sitemap.map((entry) => entry.url)

describe('kunGetSitemap', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.resetModules()
    vi.useFakeTimers()
    patchFindManyMock.mockResolvedValue([
      { unique_id: 'uid00001', resource_update_time: UPDATED }
    ])
    companyFindManyMock.mockResolvedValue([{ id: 3 }])
    getAllPostsMock.mockReturnValue([{ slug: 'post/a', date: '' }])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('作品只按游客视角查, 两张表都只取站点地图要的列, 查到的行交给构造器', async () => {
    const kunGetSitemap = await loadKunGetSitemap()

    const sitemap = await kunGetSitemap()

    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(patchFindManyMock.mock.calls[0][0]).toStrictEqual({
      where: toPatchWhere(PUBLIC_VISIBILITY),
      select: { unique_id: true, resource_update_time: true }
    })
    expect(companyFindManyMock).toHaveBeenCalledTimes(1)
    expect(companyFindManyMock.mock.calls[0][0]).toStrictEqual({
      select: { id: true }
    })
    expect(sitemap).toContainEqual({
      url: `${origin}/uid00001`,
      lastModified: UPDATED
    })
    expect(sitemap).toContainEqual({ url: `${origin}/company/3` })
    expect(sitemap).toContainEqual({ url: `${origin}/doc/post/a` })
  })

  it('TTL 之内再调不再查库, 拿到的是同一份结果', async () => {
    const kunGetSitemap = await loadKunGetSitemap()
    const first = await kunGetSitemap()

    vi.advanceTimersByTime(TTL_MS - 1)
    const second = await kunGetSitemap()

    expect(second).toBe(first)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    expect(companyFindManyMock).toHaveBeenCalledTimes(1)
    expect(getAllPostsMock).toHaveBeenCalledTimes(1)
  })

  it('TTL 到了重新查库, 返回新数据', async () => {
    const kunGetSitemap = await loadKunGetSitemap()
    await kunGetSitemap()

    vi.advanceTimersByTime(TTL_MS)
    patchFindManyMock.mockResolvedValue([
      { unique_id: 'uid00002', resource_update_time: UPDATED }
    ])
    const urls = urlsOf(await kunGetSitemap())

    expect(patchFindManyMock).toHaveBeenCalledTimes(2)
    expect(urls).toContain(`${origin}/uid00002`)
    expect(urls).not.toContain(`${origin}/uid00001`)
  })

  it('加载期间的并发调用共用同一次加载', async () => {
    const rows = Promise.withResolvers<unknown[]>()
    patchFindManyMock.mockReturnValueOnce(rows.promise)
    const kunGetSitemap = await loadKunGetSitemap()

    const first = kunGetSitemap()
    const second = kunGetSitemap()
    rows.resolve([{ unique_id: 'uid00001', resource_update_time: UPDATED }])

    expect(await second).toBe(await first)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
  })

  it('加载失败不记: 错误交给调用方, 下一次调用重新查库并能成功', async () => {
    patchFindManyMock.mockRejectedValueOnce(new Error('db down'))
    const kunGetSitemap = await loadKunGetSitemap()

    await expect(kunGetSitemap()).rejects.toThrow('db down')
    const urls = urlsOf(await kunGetSitemap())

    expect(patchFindManyMock).toHaveBeenCalledTimes(2)
    expect(urls).toContain(`${origin}/uid00001`)
  })

  it('记忆过期后重新加载失败, 抛错而不是退回旧结果', async () => {
    const kunGetSitemap = await loadKunGetSitemap()
    await kunGetSitemap()

    vi.advanceTimersByTime(TTL_MS)
    patchFindManyMock.mockRejectedValueOnce(new Error('db down'))

    await expect(kunGetSitemap()).rejects.toThrow('db down')
  })

  it('查询挂住时到点按失败处理: 等着的请求都收到错误, 下一次调用重新查库', async () => {
    patchFindManyMock.mockReturnValueOnce(new Promise(() => {}))
    const kunGetSitemap = await loadKunGetSitemap()

    const first = kunGetSitemap()
    const second = kunGetSitemap()
    const failures = Promise.all([
      expect(first).rejects.toThrow('站点地图加载超时'),
      expect(second).rejects.toThrow('站点地图加载超时')
    ])
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS - 1)
    expect(patchFindManyMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await failures

    const urls = urlsOf(await kunGetSitemap())
    expect(patchFindManyMock).toHaveBeenCalledTimes(2)
    expect(urls).toContain(`${origin}/uid00001`)
  })

  it('加载在超时之前结束, 不留下还在走的计时器', async () => {
    const kunGetSitemap = await loadKunGetSitemap()

    await kunGetSitemap()

    expect(vi.getTimerCount()).toBe(0)
  })
})
