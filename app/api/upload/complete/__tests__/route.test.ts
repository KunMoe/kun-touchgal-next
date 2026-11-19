import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyKunCsrfMock,
  verifyHeaderCookieMock,
  getKvMock,
  delKvMock,
  headObjectMock,
  deleteFileFromS3Mock
} = vi.hoisted(() => ({
  verifyKunCsrfMock: vi.fn(),
  verifyHeaderCookieMock: vi.fn(),
  getKvMock: vi.fn(),
  delKvMock: vi.fn(),
  headObjectMock: vi.fn(),
  deleteFileFromS3Mock: vi.fn()
}))

// /api/upload/* 被 proxy 的 CSRF 排除, 由 handler 自行校验; 校验细节另有测试, 这里只钉 handler 如何处理其结果
vi.mock('~/middleware/_csrf', () => ({
  verifyKunCsrf: verifyKunCsrfMock
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/lib/s3', () => ({
  headObject: headObjectMock,
  deleteFileFromS3: deleteFileFromS3Mock
}))

vi.mock('~/lib/redis', () => ({
  getKv: getKvMock,
  delKv: delKvMock
}))

import { POST } from '~/app/api/upload/complete/route'

const UID = 7
const MB = 1024 * 1024
const SIZE = 2 * MB
const TOKEN = 'upload-token-0001'
const STAGING_KEY = `patch/tmp/${UID}/${'a'.repeat(64)}/game.zip`

const meta = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    s3Key: STAGING_KEY,
    fileName: 'game.zip',
    declared: SIZE,
    uid: UID,
    ...overrides
  })

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/upload/complete', {
    method: 'POST',
    body: JSON.stringify(body)
  })

const complete = () => POST(postRequest({ token: TOKEN }))

const expectNoCleanup = () => {
  expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
  expect(delKvMock).not.toHaveBeenCalled()
}

const expectCleanedUp = () => {
  expect(deleteFileFromS3Mock).toHaveBeenCalledWith(STAGING_KEY)
  expect(delKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
}

beforeEach(() => {
  vi.resetAllMocks()
  verifyKunCsrfMock.mockReturnValue(null)
  verifyHeaderCookieMock.mockResolvedValue({ uid: UID, name: 'kun', role: 2 })
  getKvMock.mockResolvedValue(meta())
  delKvMock.mockResolvedValue(undefined)
  headObjectMock.mockResolvedValue({ ContentLength: SIZE })
  deleteFileFromS3Mock.mockResolvedValue(undefined)
})

describe('POST /api/upload/complete 前置闸门顺序', () => {
  it('CSRF 校验失败返回 403 与其错误串, 先于请求体解析与鉴权', async () => {
    verifyKunCsrfMock.mockReturnValue('非法请求来源')
    const res = await POST(postRequest({ token: '' }))

    expect(res.status).toBe(403)
    expect(await res.json()).toBe('非法请求来源')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(getKvMock).not.toHaveBeenCalled()
  })

  it('token 过短时返回校验消息, 且解析先于鉴权不读会话', async () => {
    const res = await POST(postRequest({ token: 'short' }))

    expect(res.status).toBe(200)
    expect(typeof (await res.json())).toBe('string')
    expect(verifyHeaderCookieMock).not.toHaveBeenCalled()
    expect(getKvMock).not.toHaveBeenCalled()
  })

  it('未登录返回 用户未认证, 不读令牌', async () => {
    verifyHeaderCookieMock.mockResolvedValue(null)
    const res = await complete()

    expect(await res.json()).toBe('用户未认证')
    expect(getKvMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/upload/complete 令牌', () => {
  // 预期翻转 (S2): 与 bind 统一为「…请重新上传文件」
  it('令牌不存在: 返回过期文案, 不碰对象存储', async () => {
    getKvMock.mockResolvedValue(null)
    const res = await complete()

    expect(await res.json()).toBe('上传 token 已过期或不存在, 请重新上传')
    expect(getKvMock).toHaveBeenCalledWith(`upload:${TOKEN}`)
    expect(headObjectMock).not.toHaveBeenCalled()
  })

  it('令牌属于别的用户: 拒绝, 不碰对方的暂存对象', async () => {
    getKvMock.mockResolvedValue(meta({ uid: UID + 1 }))
    const res = await complete()

    expect(await res.json()).toBe('上传 token 不属于当前用户')
    expect(headObjectMock).not.toHaveBeenCalled()
    expectNoCleanup()
  })

  // 预期翻转 (S2): 令牌内容改由 schema 解析, 损坏的内容按令牌无效返回文案, 不再抛错
  it('令牌内容不是 JSON: 抛出解析错误', async () => {
    getKvMock.mockResolvedValue('not-json')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(complete()).rejects.toBeInstanceOf(SyntaxError)
    expect(headObjectMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/upload/complete 暂存对象校验', () => {
  // 预期翻转 (S2): 与 bind 统一为「…请重新上传」
  it('HEAD 失败: 返回未上传成功, 令牌与暂存都留着供重试', async () => {
    headObjectMock.mockRejectedValue(new Error('NotFound'))
    const res = await complete()

    expect(await res.json()).toBe('文件未上传成功, 请重试')
    expectNoCleanup()
  })

  it('实际大小与声明不符: 拒绝并清掉暂存对象与令牌', async () => {
    headObjectMock.mockResolvedValue({ ContentLength: SIZE - 1 })
    const res = await complete()

    expect(await res.json()).toBe('文件大小不一致, 请重新上传')
    expectCleanedUp()
  })

  it('大小达到 1GB 上限: 拒绝并清理', async () => {
    const tooLarge = 1024 * MB
    getKvMock.mockResolvedValue(meta({ declared: tooLarge }))
    headObjectMock.mockResolvedValue({ ContentLength: tooLarge })
    const res = await complete()

    expect(await res.json()).toBe('文件大小超过限制, 必须小于 1GB')
    expectCleanedUp()
  })

  it('拒绝时的清理是尽力而为: 删对象与删令牌都失败, 文案照常返回', async () => {
    headObjectMock.mockResolvedValue({ ContentLength: SIZE - 1 })
    deleteFileFromS3Mock.mockRejectedValue(new Error('s3 down'))
    delKvMock.mockRejectedValue(new Error('redis down'))
    const res = await complete()

    expect(await res.json()).toBe('文件大小不一致, 请重新上传')
    expectCleanedUp()
  })
})

describe('POST /api/upload/complete 成功响应', () => {
  it('返回令牌与三位小数的 MB 大小; 令牌与暂存对象留给 bind', async () => {
    const res = await complete()

    expect(await res.json()).toEqual({
      filetype: 's3',
      fileToken: TOKEN,
      fileSize: '2.000 MB'
    })
    expect(headObjectMock).toHaveBeenCalledTimes(1)
    expect(headObjectMock.mock.calls[0][0]).toBe(STAGING_KEY)
    expectNoCleanup()
  })
})
