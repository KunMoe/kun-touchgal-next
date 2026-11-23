import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  verifyHeaderCookieMock,
  getKvMock,
  delKvMock,
  headObjectMock,
  deleteFileFromS3Mock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  getKvMock: vi.fn(),
  delKvMock: vi.fn(),
  headObjectMock: vi.fn(),
  deleteFileFromS3Mock: vi.fn()
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
const TOKEN_MISSING = '上传 token 已过期或不存在, 请重新上传文件'

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
  verifyHeaderCookieMock.mockResolvedValue({ uid: UID, name: 'kun', role: 2 })
  getKvMock.mockResolvedValue(meta())
  delKvMock.mockResolvedValue(undefined)
  headObjectMock.mockResolvedValue({ ContentLength: SIZE })
  deleteFileFromS3Mock.mockResolvedValue(undefined)
})

describe('POST /api/upload/complete 前置闸门顺序', () => {
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
  it('令牌不存在: 返回过期文案, 不碰对象存储', async () => {
    getKvMock.mockResolvedValue(null)
    const res = await complete()

    expect(await res.json()).toBe(TOKEN_MISSING)
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

  it.each([
    ['不是 JSON', 'not-json'],
    ['缺字段', '{}'],
    [
      '暂存 key 不在 patch/tmp/ 之下',
      meta({ s3Key: 'patch/1/resource/x/a.zip' })
    ],
    [
      '的 key 在名字一段里带路径分隔',
      meta({
        s3Key: `patch/tmp/${UID}/${'a'.repeat(64)}/../../x.zip`,
        fileName: '../../x.zip'
      })
    ]
  ])('令牌内容%s: 按令牌无效处理, 不拿它去碰对象存储', async (_, raw) => {
    getKvMock.mockResolvedValue(raw)
    const res = await complete()

    expect(await res.json()).toBe(TOKEN_MISSING)
    expect(headObjectMock).not.toHaveBeenCalled()
    expectNoCleanup()
  })
})

describe('POST /api/upload/complete 暂存对象校验', () => {
  it('HEAD 失败: 返回未上传成功, 令牌与暂存都留着供重试', async () => {
    headObjectMock.mockRejectedValue(new Error('NotFound'))
    const res = await complete()

    expect(await res.json()).toBe('文件未上传成功, 请重新上传')
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
