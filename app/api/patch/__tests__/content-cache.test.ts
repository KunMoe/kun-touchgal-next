import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  kvStore,
  lockStore,
  getKvMock,
  getKvsMock,
  setKvMock,
  setKvIfAbsentMock,
  acquireKvLockMock,
  releaseKvLockMock,
  findUniqueMock,
  favoriteFindFirstMock,
  markdownMock
} = vi.hoisted(() => {
  const kvStore = new Map<string, string>()
  const lockStore = new Set<string>()

  return {
    kvStore,
    lockStore,
    getKvMock: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    getKvsMock: vi.fn(async (keys: string[]) =>
      keys.map((key) => kvStore.get(key) ?? null)
    ),
    setKvMock: vi.fn(async (key: string, value: string) => {
      kvStore.set(key, value)
    }),
    setKvIfAbsentMock: vi.fn(async (key: string, value: string) => {
      if (!kvStore.has(key)) {
        kvStore.set(key, value)
      }
    }),
    acquireKvLockMock: vi.fn(async (key: string) => {
      if (lockStore.has(key)) {
        return null
      }
      lockStore.add(key)
      return 'lock-token'
    }),
    releaseKvLockMock: vi.fn(async (key: string) => {
      lockStore.delete(key)
    }),
    findUniqueMock: vi.fn(),
    favoriteFindFirstMock: vi.fn(),
    markdownMock: vi.fn(async (markdown: string) => `<p>${markdown}</p>`)
  }
})

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  getKvs: getKvsMock,
  setKv: setKvMock,
  setKvIfAbsent: setKvIfAbsentMock,
  delKv: vi.fn(),
  delKvs: vi.fn(),
  acquireKvLock: acquireKvLockMock,
  releaseKvLock: releaseKvLockMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findUnique: findUniqueMock },
    user_patch_favorite_folder_relation: { findFirst: favoriteFindFirstMock }
  }
}))

vi.mock('~/app/api/utils/render/markdownToHtmlExtend', () => ({
  markdownToHtmlExtend: markdownMock
}))

import { getPatchById } from '~/app/api/patch/get'
import { getPatchPageData } from '~/app/api/patch/pageData'
import { getPatchIntroduction } from '~/app/api/patch/introduction/service'
import {
  getPatchCacheKey,
  getPatchIntroductionCacheKey
} from '~/app/api/patch/cache'

const uniqueId = 'abcdefgh'
const input = { uniqueId }

const patchRow = {
  id: 7,
  unique_id: uniqueId,
  vndb_id: 'v1',
  vndb_relation_id: null,
  bangumi_id: null,
  steam_id: null,
  dlsite_code: null,
  name: '测试游戏',
  introduction: '# intro',
  banner: 'https://example.com/banner.avif',
  status: 0,
  view: 1,
  download: 2,
  type: ['galgame'],
  language: ['zh-Hans'],
  platform: ['windows'],
  content_limit: 'sfw',
  released: '2026-01-01',
  resource_update_time: '2026-01-02T00:00:00.000Z',
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-03T00:00:00.000Z',
  rating_stat: null,
  user: { id: 1, name: 'kun', avatar: '' },
  alias: [{ name: 'alias-1' }],
  tag: [{ tag: { id: 1, name: 'tag-1', count: 1, alias: [] } }],
  company: [{ company: { id: 2, name: 'company-1', count: 1, alias: [] } }],
  favorite_count: 3,
  resource_count: 2,
  comment_count: 1
}

beforeEach(() => {
  vi.clearAllMocks()
  kvStore.clear()
  lockStore.clear()
  findUniqueMock.mockResolvedValue(patchRow)
  favoriteFindFirstMock.mockResolvedValue(null)
})

describe('getPatchById', () => {
  it('缓存命中时不查询数据库、不加锁', async () => {
    await getPatchById(input, null)
    findUniqueMock.mockClear()
    acquireKvLockMock.mockClear()

    const result = await getPatchById(input, null)

    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ id: 7, uniqueId, isFavorite: false })
  })

  it('并发 miss 时仅持锁者回源, 等待者从缓存读取', async () => {
    const [first, second] = await Promise.all([
      getPatchById(input, null),
      getPatchById(input, null)
    ])

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(acquireKvLockMock).toHaveBeenCalledWith(
      `${getPatchCacheKey(uniqueId)}:lock`,
      expect.any(Number)
    )
    expect(first).toEqual(second)
    expect(first).toMatchObject({ id: 7, uniqueId, isFavorite: false })
    expect(kvStore.has(getPatchCacheKey(uniqueId))).toBe(true)
  })

  it('前一请求释放锁后才获锁时从缓存读取而不重复回源', async () => {
    let resolveFirstRelease!: () => void
    const firstReleased = new Promise<void>((resolve) => {
      resolveFirstRelease = resolve
    })
    acquireKvLockMock
      .mockImplementationOnce(async (key: string) => {
        lockStore.add(key)
        return 'lock-token'
      })
      .mockImplementationOnce(async (key: string) => {
        await firstReleased
        lockStore.add(key)
        return 'lock-token'
      })
    releaseKvLockMock.mockImplementationOnce(async (key: string) => {
      lockStore.delete(key)
      resolveFirstRelease()
    })

    const [first, second] = await Promise.all([
      getPatchById(input, null),
      getPatchById(input, null)
    ])

    expect(acquireKvLockMock).toHaveBeenCalledTimes(2)
    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
  })

  it('查无此作品时返回错误消息且不写缓存', async () => {
    findUniqueMock.mockResolvedValue(null)

    await expect(getPatchById(input, null)).resolves.toBe('未找到对应 Galgame')

    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('拿不到锁且缓存持续为空时回退直查并以 NX 补写', async () => {
    acquireKvLockMock.mockResolvedValueOnce(null)

    const result = await getPatchById(input, null)

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).toHaveBeenCalledTimes(1)
    expect(kvStore.has(getPatchCacheKey(uniqueId))).toBe(true)
    expect(result).toMatchObject({ id: 7, uniqueId, isFavorite: false })
  })

  it('NX 补写失败时仍返回回源结果并处理异步异常', async () => {
    const error = new Error('Redis NX write failed')
    acquireKvLockMock.mockResolvedValueOnce(null)
    setKvIfAbsentMock.mockRejectedValueOnce(error)
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    try {
      const result = await getPatchById(input, null)

      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          `Failed to write fallback cache for ${getPatchCacheKey(uniqueId)}:`,
          error
        )
      })
      expect(result).toMatchObject({ id: 7, uniqueId, isFavorite: false })
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('getPatchPageData', () => {
  it('并发 miss 时仅持锁者回源, 等待者从缓存读取', async () => {
    const [first, second] = await Promise.all([
      getPatchPageData(input, null),
      getPatchPageData(input, null)
    ])

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(markdownMock).toHaveBeenCalledTimes(1)
    expect(acquireKvLockMock).toHaveBeenCalledWith(
      `${getPatchIntroductionCacheKey(uniqueId)}:lock`,
      expect.any(Number)
    )
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      patch: { id: 7, uniqueId, isFavorite: false },
      intro: { introduction: '<p># intro</p>' }
    })
    expect(kvStore.has(getPatchCacheKey(uniqueId))).toBe(true)
    expect(kvStore.has(getPatchIntroductionCacheKey(uniqueId))).toBe(true)
  })

  it('patch 缓存命中但 introduction 缺失时仍回源并补齐两个缓存', async () => {
    await getPatchPageData(input, null)
    kvStore.delete(getPatchIntroductionCacheKey(uniqueId))
    findUniqueMock.mockClear()

    const result = await getPatchPageData(input, null)

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      patch: { id: 7, uniqueId, isFavorite: false }
    })
    expect(kvStore.has(getPatchCacheKey(uniqueId))).toBe(true)
    expect(kvStore.has(getPatchIntroductionCacheKey(uniqueId))).toBe(true)
  })

  it('查无此作品时返回错误消息且不写缓存', async () => {
    findUniqueMock.mockResolvedValue(null)

    await expect(getPatchPageData(input, null)).resolves.toBe(
      '未找到对应 Galgame'
    )

    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })

  it('拿不到锁且缓存持续为空时回退直查并以 NX 补写', async () => {
    acquireKvLockMock.mockResolvedValueOnce(null)

    const result = await getPatchPageData(input, null)

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).toHaveBeenCalledTimes(2)
    expect(kvStore.has(getPatchCacheKey(uniqueId))).toBe(true)
    expect(kvStore.has(getPatchIntroductionCacheKey(uniqueId))).toBe(true)
    expect(result).toMatchObject({
      patch: { id: 7, uniqueId, isFavorite: false }
    })
  })
})

// 关系 _count 会被 Prisma 编译成子表整表 GROUP BY (C3), 详情计数必须读计数列
describe('详情计数读触发器计数列', () => {
  const expectedCount = { favorite_folder: 3, resource: 2, comment: 1 }

  it('getPatchById 不查关系 _count, 由计数列映射', async () => {
    const result = await getPatchById(input, null)

    expect(findUniqueMock.mock.calls[0][0].include).not.toHaveProperty('_count')
    expect(result).toMatchObject({ _count: expectedCount })
  })

  it('getPatchPageData 不查关系 _count, 由计数列映射', async () => {
    const result = await getPatchPageData(input, null)

    expect(findUniqueMock.mock.calls[0][0].include).not.toHaveProperty('_count')
    expect(result).toMatchObject({ patch: { _count: expectedCount } })
  })
})

describe('getPatchIntroduction', () => {
  it('缓存命中时不查询数据库、不加锁', async () => {
    await getPatchIntroduction(input)
    findUniqueMock.mockClear()
    acquireKvLockMock.mockClear()

    const result = await getPatchIntroduction(input)

    expect(findUniqueMock).not.toHaveBeenCalled()
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ introduction: '<p># intro</p>' })
  })

  it('并发 miss 时仅持锁者回源, 等待者从缓存读取', async () => {
    const [first, second] = await Promise.all([
      getPatchIntroduction(input),
      getPatchIntroduction(input)
    ])

    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(markdownMock).toHaveBeenCalledTimes(1)
    expect(acquireKvLockMock).toHaveBeenCalledWith(
      `${getPatchIntroductionCacheKey(uniqueId)}:intro:lock`,
      expect.any(Number)
    )
    expect(first).toEqual(second)
    expect(first).toMatchObject({ introduction: '<p># intro</p>' })
    expect(kvStore.has(getPatchIntroductionCacheKey(uniqueId))).toBe(true)
  })

  it('查无此作品时返回错误消息且不写缓存', async () => {
    findUniqueMock.mockResolvedValue(null)

    await expect(getPatchIntroduction(input)).resolves.toBe(
      '未找到对应 Galgame'
    )

    expect(setKvMock).not.toHaveBeenCalled()
    expect(setKvIfAbsentMock).not.toHaveBeenCalled()
  })
})

describe('Redis 故障降级', () => {
  const redisError = new Error('Redis unavailable')
  const viewer = { uid: 42, role: 1 }
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
  })

  // mockRejectedValue 覆盖的是 hoisted 里的默认实现, clearAllMocks 不会恢复它
  afterEach(() => {
    consoleError.mockRestore()
    getKvMock.mockImplementation(
      async (key: string) => kvStore.get(key) ?? null
    )
    getKvsMock.mockImplementation(async (keys: string[]) =>
      keys.map((key) => kvStore.get(key) ?? null)
    )
    setKvMock.mockImplementation(async (key: string, value: string) => {
      kvStore.set(key, value)
    })
  })

  it('读缓存抛错时 getPatchById 直连数据库且不参与单飞', async () => {
    getKvMock.mockRejectedValue(redisError)

    const result = await getPatchById(input, null)

    expect(result).toMatchObject({ id: 7, uniqueId, isFavorite: false })
    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('读缓存抛错时 getPatchPageData 直连数据库且不参与单飞', async () => {
    getKvMock.mockRejectedValue(redisError)

    const result = await getPatchPageData(input, null)

    expect(result).toMatchObject({
      patch: { id: 7, uniqueId, isFavorite: false },
      intro: { introduction: '<p># intro</p>' }
    })
    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('读缓存抛错时 getPatchIntroduction 直连数据库且不参与单飞', async () => {
    getKvMock.mockRejectedValue(redisError)

    const result = await getPatchIntroduction(input)

    expect(result).toMatchObject({ introduction: '<p># intro</p>' })
    expect(findUniqueMock).toHaveBeenCalledTimes(1)
    expect(acquireKvLockMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  it('写缓存抛错时持锁者仍返回回源结果', async () => {
    setKvMock.mockRejectedValue(redisError)

    const result = await getPatchPageData(input, null)

    expect(result).toMatchObject({
      patch: { id: 7, uniqueId, isFavorite: false },
      intro: { introduction: '<p># intro</p>' }
    })
    expect(consoleError).toHaveBeenCalledWith(
      `Failed to write cache for ${getPatchIntroductionCacheKey(uniqueId)}:`,
      redisError
    )
  })

  it('收藏状态缓存读抛错时回源数据库判定收藏且不写回', async () => {
    getKvsMock.mockRejectedValue(redisError)
    favoriteFindFirstMock.mockResolvedValue({ id: 3 })

    const result = await getPatchById(input, viewer)

    expect(result).toMatchObject({ id: 7, uniqueId, isFavorite: true })
    expect(favoriteFindFirstMock).toHaveBeenCalledTimes(1)
    // 写回会在慢 Redis 下再耗一个 commandTimeout, 读失败后必须跳过
    expect(setKvMock).not.toHaveBeenCalledWith(
      expect.stringContaining('patch:favorite'),
      expect.anything(),
      expect.anything()
    )
  })

  it('收藏状态缓存写抛错时不影响响应', async () => {
    setKvMock.mockRejectedValue(redisError)

    await expect(getPatchById(input, viewer)).resolves.toMatchObject({
      id: 7,
      uniqueId,
      isFavorite: false
    })
    expect(favoriteFindFirstMock).toHaveBeenCalledTimes(1)
  })
})
