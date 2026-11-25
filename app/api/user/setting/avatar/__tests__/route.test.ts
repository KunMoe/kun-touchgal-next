import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import {
  createGarbage,
  createPixelBomb,
  createPng,
  createTruncatedPng,
  saturateEncodeQueue
} from '~/server/image/__tests__/_fixtures'

const {
  verifyHeaderCookieMock,
  userFindUniqueMock,
  userUpdateManyMock,
  userUpdateMock,
  txUserUpdateMock,
  kunTxMock,
  uploadImageToS3Mock,
  copyObjectMock,
  purgeCloudflareCacheMock,
  invalidateUserSessionMock,
  hasPendingModerationMock,
  preScreenMediaMock,
  createModerationTaskMock
} = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  userUpdateManyMock: vi.fn(),
  userUpdateMock: vi.fn(),
  txUserUpdateMock: vi.fn(),
  kunTxMock: vi.fn(),
  uploadImageToS3Mock: vi.fn(),
  copyObjectMock: vi.fn(),
  purgeCloudflareCacheMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  preScreenMediaMock: vi.fn(),
  createModerationTaskMock: vi.fn()
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

// 额度的抢占与退还走真实的 imageQuota, 这里只替换它下面的 updateMany
vi.mock('~/prisma/index', () => ({
  prisma: {
    user: {
      findUnique: userFindUniqueMock,
      updateMany: userUpdateManyMock,
      update: userUpdateMock
    }
  }
}))

vi.mock('~/server/db/tx', () => ({ kunTx: kunTxMock }))

// 编码用真 sharp, 只替换 S3
vi.mock('~/lib/s3', () => ({
  uploadImageToS3: uploadImageToS3Mock,
  copyObject: copyObjectMock
}))

vi.mock('~/app/api/utils/purgeCloudflareCache', () => ({
  purgeCloudflareCache: purgeCloudflareCacheMock
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

vi.mock('~/server/moderation/submit', () => ({
  hasPendingModeration: hasPendingModerationMock,
  preScreenMedia: preScreenMediaMock,
  createModerationTask: createModerationTaskMock
}))

import { POST } from '~/app/api/user/setting/avatar/route'

const UID = 7
const IMAGE_BED_URL = 'https://img.example.test'
const MODERATION_SKIP = { queue: false, intercept: false, dryRun: false }

const postAvatar = (bytes: ArrayBuffer) => {
  const formData = new FormData()
  formData.append('avatar', new File([bytes], 'avatar.webp'))
  return POST(
    new NextRequest('http://localhost/api/user/setting/avatar', {
      method: 'POST',
      body: formData
    })
  )
}

const quotaCalls = (direction: 'increment' | 'decrement') =>
  userUpdateManyMock.mock.calls.filter(
    ([args]) => args.data.daily_image_count[direction] === 1
  ).length

const writtenKeys = () =>
  uploadImageToS3Mock.mock.calls.map(([key]) => key as string)

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', IMAGE_BED_URL)
  verifyHeaderCookieMock.mockResolvedValue({ uid: UID, name: 'kun', role: 1 })
  userFindUniqueMock.mockResolvedValue({ id: UID })
  userUpdateManyMock.mockResolvedValue({ count: 1 })
  userUpdateMock.mockResolvedValue({})
  kunTxMock.mockImplementation(async (_name, body) =>
    body({ tx: { user: { update: txUserUpdateMock } } })
  )
  uploadImageToS3Mock.mockResolvedValue(undefined)
  copyObjectMock.mockResolvedValue(undefined)
  purgeCloudflareCacheMock.mockResolvedValue(undefined)
  hasPendingModerationMock.mockResolvedValue(false)
  preScreenMediaMock.mockResolvedValue(MODERATION_SKIP)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/user/setting/avatar', () => {
  it('不送审: 抢占 1 次、不退还, 两个变体写正式 key, 头像地址落库', async () => {
    const res = await (await postAvatar(await createPng(512, 512))).json()

    expect(res).toEqual({
      avatar: expect.stringMatching(
        /^https:\/\/img\.example\.test\/user\/avatar\/user_7\/avatar-mini\.avif\?v=/
      )
    })
    expect(quotaCalls('increment')).toBe(1)
    expect(quotaCalls('decrement')).toBe(0)
    expect(writtenKeys()).toEqual([
      'user/avatar/user_7/avatar.avif',
      'user/avatar/user_7/avatar-mini.avif'
    ])
    expect(userUpdateMock).toHaveBeenCalledWith({
      where: { id: UID },
      data: { avatar: res.avatar, avatar_status: 0 }
    })
    expect(createModerationTaskMock).not.toHaveBeenCalled()
  })

  it('送审拦截: 写每次唯一的暂存 key, 在事务里建任务, 不碰正式 key', async () => {
    preScreenMediaMock.mockResolvedValue({
      queue: true,
      intercept: true,
      dryRun: false
    })

    const res = await (await postAvatar(await createPng(512, 512))).json()

    expect(res).toEqual({
      avatar: expect.stringContaining('/user/avatar/user_7/pending/'),
      pending: true
    })
    const [pendingKey, pendingMiniKey] = writtenKeys()
    expect(pendingKey).toMatch(/^user\/avatar\/user_7\/pending\/[^/]+\.avif$/)
    expect(pendingMiniKey).toBe(pendingKey.replace(/\.avif$/, '-mini.avif'))
    expect(txUserUpdateMock).toHaveBeenCalledWith({
      where: { id: UID },
      data: { avatar_status: 1 }
    })
    expect(createModerationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'avatar',
        dryRun: false,
        payload: expect.objectContaining({ pendingKey, pendingMiniKey })
      }),
      expect.anything()
    )
    expect(userUpdateMock).not.toHaveBeenCalled()
    expect(quotaCalls('increment')).toBe(1)
    expect(quotaCalls('decrement')).toBe(0)
  })

  it('已有头像在审核中: 拒绝, 不抢额度也不送审预检', async () => {
    hasPendingModerationMock.mockResolvedValue(true)

    expect(await (await postAvatar(await createPng(64, 64))).json()).toBe(
      '您提交的头像正在审核中, 暂时无法更换'
    )
    expect(preScreenMediaMock).not.toHaveBeenCalled()
    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('送审预检拒绝 (在途任务超限): 原样返回, 不抢额度', async () => {
    preScreenMediaMock.mockResolvedValue('您有太多内容正在审核中')

    expect(await (await postAvatar(await createPng(64, 64))).json()).toBe(
      '您有太多内容正在审核中'
    )
    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('准入排在审核闸门之后: 已有头像在审核中时先回审核提示', async () => {
    hasPendingModerationMock.mockResolvedValue(true)

    expect(await (await postAvatar(createGarbage())).json()).toBe(
      '您提交的头像正在审核中, 暂时无法更换'
    )
  })

  it('额度用尽时直接拒绝, 不编码也不写入', async () => {
    userUpdateManyMock.mockResolvedValue({ count: 0 })

    expect(await (await postAvatar(await createPng(64, 64))).json()).toBe(
      '您今日上传的图片已达到 50 张限额'
    )
    expect(quotaCalls('decrement')).toBe(0)
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('像素炸弹: 准入就拒绝, 不扣额度也不写入', async () => {
    expect(await (await postAvatar(await createPixelBomb())).json()).toBe(
      '图片尺寸过大'
    )
    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  }, 30000)

  it('认不出的字节: 准入就拒绝, 不扣额度也不写入', async () => {
    expect(await (await postAvatar(createGarbage())).json()).toBe(
      '无法识别的图片文件'
    )
    expect(userUpdateManyMock).not.toHaveBeenCalled()
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('文件头完整、像素数据损坏: 已经花了解码成本, 返回文案且不退额度', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await (await postAvatar(await createTruncatedPng())).json()).toBe(
      '图片已损坏或无法解码'
    )
    expect(quotaCalls('increment')).toBe(1)
    expect(quotaCalls('decrement')).toBe(0)
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('编码排队已满: 返回限流提示并退还额度', async () => {
    const image = await createPng(64, 64)
    const release = await saturateEncodeQueue()
    try {
      expect(await (await postAvatar(image)).json()).toBe(
        '服务器繁忙, 请稍后重试'
      )
    } finally {
      await release()
    }
    expect(quotaCalls('increment')).toBe(1)
    expect(quotaCalls('decrement')).toBe(1)
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('S3 写入失败: 退还额度后原样抛出, 头像地址不落库', async () => {
    uploadImageToS3Mock.mockRejectedValue(new Error('s3 down'))

    await expect(postAvatar(await createPng(64, 64))).rejects.toThrow('s3 down')
    expect(quotaCalls('increment')).toBe(1)
    expect(quotaCalls('decrement')).toBe(1)
    expect(userUpdateMock).not.toHaveBeenCalled()
  })
})
