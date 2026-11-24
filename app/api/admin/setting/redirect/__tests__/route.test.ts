import { beforeEach, describe, expect, it, vi } from 'vitest'
import { adminUpdateRedirectSchema } from '~/validations/admin'

const {
  kunParsePutBodyMock,
  verifyHeaderCookieMock,
  getKvMock,
  setKvMock,
  findSettingMock,
  upsertSettingMock,
  readFileMock,
  resolveRuntimeFileMock,
  invalidateAllUserSessionsMock
} = vi.hoisted(() => ({
  kunParsePutBodyMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  getKvMock: vi.fn(),
  setKvMock: vi.fn(),
  findSettingMock: vi.fn(),
  upsertSettingMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveRuntimeFileMock: vi.fn(),
  invalidateAllUserSessionsMock: vi.fn()
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/app/api/utils/parseQuery', () => ({
  kunParsePutBody: kunParsePutBodyMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  setKv: setKvMock
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    admin_setting: { findUnique: findSettingMock, upsert: upsertSettingMock }
  }
}))

vi.mock('fs/promises', () => ({
  readFile: readFileMock
}))

vi.mock('~/lib/runtimePaths', () => ({
  resolveRuntimeFile: resolveRuntimeFileMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateAllUserSessions: invalidateAllUserSessionsMock
}))

import { GET, PUT } from '~/app/api/admin/setting/redirect/route'

const REDIS_KEY = 'admin:config:redirect'

const savedConfig = {
  enableRedirect: true,
  excludedDomains: ['example.com'],
  delaySeconds: 3
}

const fileConfig = {
  enableRedirect: false,
  excludedDomains: [],
  delaySeconds: 5
}

const getRequest = new Request(
  'http://localhost/api/admin/setting/redirect'
) as unknown as Parameters<typeof GET>[0]

const putRequest = new Request('http://localhost/api/admin/setting/redirect', {
  method: 'PUT'
}) as unknown as Parameters<typeof PUT>[0]

beforeEach(() => {
  vi.resetAllMocks()
  verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 4 })
  kunParsePutBodyMock.mockResolvedValue(savedConfig)
  getKvMock.mockResolvedValue(null)
  findSettingMock.mockResolvedValue(null)
  upsertSettingMock.mockResolvedValue({})
  setKvMock.mockResolvedValue(undefined)
  readFileMock.mockResolvedValue(JSON.stringify(fileConfig))
  resolveRuntimeFileMock.mockReturnValue('/tmp/config/redirect.json')
  invalidateAllUserSessionsMock.mockResolvedValue(undefined)
})

describe('GET /api/admin/setting/redirect', () => {
  it('returns the cached config on a redis hit without touching db or disk', async () => {
    getKvMock.mockResolvedValue(JSON.stringify(savedConfig))

    const response = await GET(getRequest)

    await expect(response.json()).resolves.toEqual(savedConfig)
    expect(findSettingMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('falls back to admin_setting on a redis miss and backfills the cache', async () => {
    findSettingMock.mockResolvedValue({ key: 'redirect', value: savedConfig })

    const response = await GET(getRequest)

    await expect(response.json()).resolves.toEqual(savedConfig)
    expect(findSettingMock).toHaveBeenCalledWith({
      where: { key: 'redirect' }
    })
    expect(setKvMock).toHaveBeenCalledWith(
      REDIS_KEY,
      JSON.stringify(savedConfig),
      86400
    )
    // 事实源在库中命中时绝不能再读构建期打包的旧文件
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('reads the factory default file only when both redis and db are empty', async () => {
    const response = await GET(getRequest)

    await expect(response.json()).resolves.toEqual(fileConfig)
    expect(readFileMock).toHaveBeenCalled()
    expect(setKvMock).toHaveBeenCalledWith(
      REDIS_KEY,
      JSON.stringify(fileConfig),
      86400
    )
  })

  it('rejects unauthenticated and low-role users', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    await expect((await GET(getRequest)).json()).resolves.toBe('用户未登录')

    verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 3 })
    await expect((await GET(getRequest)).json()).resolves.toBe(
      '本页面仅超级管理员可访问'
    )
    expect(getKvMock).not.toHaveBeenCalled()
  })
})

describe('PUT /api/admin/setting/redirect', () => {
  it('writes through to admin_setting, refreshes cache and invalidates sessions', async () => {
    const response = await PUT(putRequest)

    await expect(response.json()).resolves.toEqual({})
    expect(upsertSettingMock).toHaveBeenCalledWith({
      where: { key: 'redirect' },
      create: { key: 'redirect', value: savedConfig },
      update: { value: savedConfig }
    })
    expect(setKvMock).toHaveBeenCalledWith(
      REDIS_KEY,
      JSON.stringify(savedConfig),
      86400
    )
    expect(invalidateAllUserSessionsMock).toHaveBeenCalled()
  })

  it('returns the validation error message without persisting anything', async () => {
    kunParsePutBodyMock.mockResolvedValue('跳转延时不能为负数')

    const response = await PUT(putRequest)

    await expect(response.json()).resolves.toBe('跳转延时不能为负数')
    expect(upsertSettingMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })

  // value 是 jsonb: 孤立代理会让 PG 拒收整条写入; JSON 请求体的 \u 转义能带进来
  it('writes lone surrogates as U+FFFD to the jsonb column and the cache', async () => {
    kunParsePutBodyMock.mockResolvedValue({
      ...savedConfig,
      excludedDomains: ['a\udc00.example', 'b.example']
    })

    await PUT(putRequest)

    const written = {
      ...savedConfig,
      excludedDomains: ['a\ufffd.example', 'b.example']
    }
    expect(upsertSettingMock).toHaveBeenCalledWith({
      where: { key: 'redirect' },
      create: { key: 'redirect', value: written },
      update: { value: written }
    })
    expect(setKvMock).toHaveBeenCalledWith(
      REDIS_KEY,
      JSON.stringify(written),
      86400
    )
  })

  it('rejects low-role users before persisting', async () => {
    verifyHeaderCookieMock.mockResolvedValue({ uid: 1, role: 3 })

    const response = await PUT(putRequest)

    await expect(response.json()).resolves.toBe('本页面仅超级管理员可访问')
    expect(upsertSettingMock).not.toHaveBeenCalled()
    expect(invalidateAllUserSessionsMock).not.toHaveBeenCalled()
  })
})

describe('adminUpdateRedirectSchema delaySeconds bounds', () => {
  const base = { enableRedirect: true, excludedDomains: [] }

  it('rejects negative and oversized delays', () => {
    expect(
      adminUpdateRedirectSchema.safeParse({ ...base, delaySeconds: -1 }).success
    ).toBe(false)
    expect(
      adminUpdateRedirectSchema.safeParse({ ...base, delaySeconds: 61 }).success
    ).toBe(false)
  })

  it('accepts delays within [0, 60]', () => {
    expect(
      adminUpdateRedirectSchema.safeParse({ ...base, delaySeconds: 0 }).success
    ).toBe(true)
    expect(
      adminUpdateRedirectSchema.safeParse({ ...base, delaySeconds: 60 }).success
    ).toBe(true)
  })
})
