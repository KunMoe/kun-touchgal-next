import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getKvMock, setKvMock, patchFindFirstMock, fetchMock } = vi.hoisted(
  () => ({
    getKvMock: vi.fn(),
    setKvMock: vi.fn(),
    patchFindFirstMock: vi.fn(),
    fetchMock: vi.fn()
  })
)

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: setKvMock
}))

vi.mock('~/prisma', () => ({
  prisma: {
    patch: { findFirst: patchFindFirstMock }
  }
}))

import { getMoyuPatchResources } from '../service'

const CACHE_KEY = 'moyu:patch-resource:v4145'

const resource = {
  id: '10463',
  patch_id: '11617',
  name: '汉化补丁',
  storage: 's3',
  size: '0.571 MB',
  model_name: '',
  localization_group_name: '',
  note: '',
  type: ['manual'],
  language: ['zh-Hans'],
  platform: ['windows'],
  download_count: 0,
  web_url: 'https://www.moyu.moe/resource/10463',
  created_at: '2025-11-02T09:14:33Z',
  updated_at: '2026-08-29T02:51:07Z',
  publisher: {
    id: '1',
    name: 'kun',
    avatar_url: '',
    web_url: 'https://www.moyu.moe/user/1'
  }
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

describe('getMoyuPatchResources', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('KUN_NEXTMOE_API_BASE', 'https://api.nextmoe.dev')
    vi.stubEnv('KUN_NEXTMOE_API_KEY', 'nmk_live_test')
    getKvMock.mockResolvedValue(null)
    setKvMock.mockResolvedValue(undefined)
    patchFindFirstMock.mockResolvedValue({ id: 1 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('未配置密钥时直接返回空且不触发出站请求', async () => {
    vi.stubEnv('KUN_NEXTMOE_API_KEY', '')

    await expect(getMoyuPatchResources('v4145')).resolves.toEqual([])
    expect(getKvMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('命中缓存时不查库也不请求上游', async () => {
    getKvMock.mockResolvedValue(JSON.stringify([resource]))

    await expect(getMoyuPatchResources('v4145')).resolves.toEqual([resource])
    expect(getKvMock).toHaveBeenCalledWith(CACHE_KEY)
    expect(patchFindFirstMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('本站未收录的 vndb_id 不请求上游', async () => {
    patchFindFirstMock.mockResolvedValue(null)

    await expect(getMoyuPatchResources('v4145')).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('以 refs + nsfw=true + include 请求上游并缓存首个补丁页的资源', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        object: 'list',
        items: [{ id: '11617', vndb_id: 'v4145', resources: [resource] }],
        next_cursor: null,
        total: null,
        missing: []
      })
    )

    await expect(getMoyuPatchResources('v4145')).resolves.toEqual([resource])

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit]
    expect(url.origin + url.pathname).toBe(
      'https://api.nextmoe.dev/v2/moyu/patches'
    )
    expect(url.searchParams.get('refs')).toBe('vndb:v4145')
    expect(url.searchParams.get('nsfw')).toBe('true')
    expect(url.searchParams.get('include')).toBe('resources,publisher')
    expect(init.headers).toEqual({ Authorization: 'Bearer nmk_live_test' })
    expect(setKvMock).toHaveBeenCalledWith(
      CACHE_KEY,
      JSON.stringify([resource]),
      30 * 60
    )
  })

  it('上游未收录该游戏时返回空并缓存空结果', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        object: 'list',
        items: [],
        next_cursor: null,
        total: null,
        missing: ['vndb:v4145']
      })
    )

    await expect(getMoyuPatchResources('v4145')).resolves.toEqual([])
    expect(setKvMock).toHaveBeenCalledWith(CACHE_KEY, '[]', 30 * 60)
  })

  it('上游报错时返回错误消息且不写缓存', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValue(
      jsonResponse({ status: 429, code: 'RATE_LIMITED' }, 429)
    )

    await expect(getMoyuPatchResources('v4145')).resolves.toBe(
      '获取鲲 Galgame 补丁资源失败'
    )
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('读缓存失败时降级为直接请求上游', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getKvMock.mockRejectedValue(new Error('redis down'))
    fetchMock.mockResolvedValue(
      jsonResponse({
        object: 'list',
        items: [],
        next_cursor: null,
        total: null
      })
    )

    await expect(getMoyuPatchResources('v4145')).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
