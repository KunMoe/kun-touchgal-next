import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import {
  createGarbage,
  createPixelBomb,
  createPng,
  createSvg,
  createTruncatedPng,
  saturateEncodeQueue
} from '~/server/image/__tests__/_fixtures'

const {
  verifyHeaderCookieMock,
  userFindUniqueMock,
  userUpdateManyMock,
  invalidateUserSessionMock,
  uploadImageToS3Mock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  uploadImageToS3Mock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// 额度的抢占与退还走真实的 imageQuota, 这里只替换它下面的 updateMany
vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findUnique: userFindUniqueMock, updateMany: userUpdateManyMock }
  }
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

// 编码用真 sharp, 只替换 S3 写入
vi.mock('~/lib/s3', () => ({
  uploadImageToS3: uploadImageToS3Mock
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { POST } from '~/app/api/user/image/route'

const IMAGE_BED_URL = 'https://img.example.test'

const postImage = (bytes: ArrayBuffer) => {
  const formData = new FormData()
  formData.append('image', new File([bytes], 'a.png'))
  return POST(
    new NextRequest('http://localhost/api/user/image', {
      method: 'POST',
      body: formData
    })
  )
}

const quotaCalls = (direction: 'increment' | 'decrement') =>
  userUpdateManyMock.mock.calls.filter(
    ([args]) => args.data.daily_image_count[direction] === 1
  ).length

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', IMAGE_BED_URL)
  verifyHeaderCookieMock.mockResolvedValue({ uid: 7, name: 'kun', role: 1 })
  userFindUniqueMock.mockResolvedValue({ id: 7 })
  userUpdateManyMock.mockResolvedValue({ count: 1 })
  uploadImageToS3Mock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/user/image', () => {
  // 原先 key 只有 uid 与毫秒时间戳, 同一毫秒的第二次上传静默覆盖第一次 (X06-03)
  it('同一毫秒的两次上传写到不同的 key, 返回的地址就是写入的那个 key', async () => {
    const image = await createPng(120, 80)
    vi.spyOn(Date, 'now').mockReturnValue(1_732_500_000_000)

    const first = await (await postImage(image)).json()
    const second = await (await postImage(image)).json()

    const [firstKey, secondKey] = uploadImageToS3Mock.mock.calls.map(
      ([key]) => key as string
    )
    expect(firstKey).not.toBe(secondKey)
    expect(firstKey).toMatch(
      /^user\/image\/7\/7-1732500000000-[0-9a-f]{8}\.avif$/
    )
    expect(first).toEqual({ imageLink: `${IMAGE_BED_URL}/${firstKey}` })
    expect(second).toEqual({ imageLink: `${IMAGE_BED_URL}/${secondKey}` })
  })

  it('正常上传: 抢占 1 次、不退还, 写一个变体并刷新会话缓存', async () => {
    const res = await (await postImage(await createPng(1200, 800))).json()

    expect(res).toEqual({ imageLink: expect.stringMatching(/\.avif$/) })
    expect(quotaCalls('increment')).toBe(1)
    expect(quotaCalls('decrement')).toBe(0)
    expect(uploadImageToS3Mock).toHaveBeenCalledTimes(1)
    expect(invalidateUserSessionMock).toHaveBeenCalledWith(7)
  })

  it('额度用尽时直接拒绝, 不编码也不写入', async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 })

    expect(await (await postImage(await createPng(120, 80))).json()).toBe(
      '您今日上传的图片已达到 50 张限额'
    )
    expect(quotaCalls('decrement')).toBe(0)
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('像素炸弹: 准入就拒绝, 不扣额度也不写入', async () => {
    expect(await (await postImage(await createPixelBomb())).json()).toBe(
      '图片尺寸过大'
    )
    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  }, 30000)

  it('认不出的字节: 准入就拒绝, 不扣额度也不写入', async () => {
    expect(await (await postImage(createGarbage())).json()).toBe(
      '无法识别的图片文件'
    )
    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('SVG: 准入就拒绝, 不扣额度也不写入', async () => {
    expect(await (await postImage(createSvg())).json()).toBe(
      '不支持该图片格式, 仅支持 jpg、png、webp、avif、gif'
    )
    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('文件头完整、像素数据损坏: 已经花了解码成本, 返回文案且不退额度', async () => {
    expect(await (await postImage(await createTruncatedPng())).json()).toBe(
      '图片已损坏或无法处理'
    )
    expect(quotaCalls('increment')).toBe(1)
    expect(quotaCalls('decrement')).toBe(0)
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('编码排队已满: 返回限流提示并退还额度', async () => {
    const image = await createPng(120, 80)
    const release = await saturateEncodeQueue()
    try {
      expect(await (await postImage(image)).json()).toBe(
        '服务器繁忙, 请稍后重试'
      )
    } finally {
      await release()
    }
    expect(quotaCalls('increment')).toBe(1)
    expect(quotaCalls('decrement')).toBe(1)
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('S3 写入失败: 退还额度后原样抛出', async () => {
    uploadImageToS3Mock.mockRejectedValue(new Error('s3 down'))

    await expect(postImage(await createPng(120, 80))).rejects.toThrow('s3 down')
    expect(quotaCalls('increment')).toBe(1)
    expect(quotaCalls('decrement')).toBe(1)
    expect(invalidateUserSessionMock).not.toHaveBeenCalled()
  })
})
