import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

const { copyObjectMock, uploadImageToS3Mock } = vi.hoisted(() => ({
  copyObjectMock: vi.fn(),
  uploadImageToS3Mock: vi.fn()
}))

vi.mock('~/lib/s3', () => ({
  copyObject: copyObjectMock,
  uploadImageToS3: uploadImageToS3Mock
}))

import {
  archiveAvatarForModeration,
  uploadUserAvatar
} from '~/app/api/user/setting/_upload'

const createPng = async (
  width: number,
  height: number
): Promise<ArrayBuffer> => {
  const buf = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 }
    }
  })
    .png()
    .toBuffer()
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength
  ) as ArrayBuffer
}

describe('archiveAvatarForModeration', () => {
  beforeEach(() => {
    copyObjectMock.mockReset()
    process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL = 'https://img.example.com'
  })

  it('复制成功返回留档图床 URL, 且带墙钟超时信号', async () => {
    copyObjectMock.mockResolvedValue(undefined)
    const link = await archiveAvatarForModeration('src-key', 42, 'nonce-abc')
    expect(link).toBe(
      'https://img.example.com/user/avatar/user_42/moderation/nonce-abc.avif'
    )
    expect(copyObjectMock).toHaveBeenCalledWith(
      'src-key',
      'user/avatar/user_42/moderation/nonce-abc.avif',
      expect.any(AbortSignal)
    )
  })

  it('复制失败返回 undefined 而不抛出 —— 留档降级不阻断头像上传主流程', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    copyObjectMock.mockRejectedValue(new Error('s3 down'))
    await expect(
      archiveAvatarForModeration('src-key', 42, 'nonce-abc')
    ).resolves.toBeUndefined()
    errorSpy.mockRestore()
  })
})

describe('uploadUserAvatar', () => {
  beforeEach(() => {
    uploadImageToS3Mock.mockReset()
    uploadImageToS3Mock.mockResolvedValue(undefined)
  })

  it('原图像素数超过上限时前置拒绝, 不触发编码与上传', async () => {
    const bomb = await createPng(8000, 7000) // 56M > 50M 上限
    const res = await uploadUserAvatar(bomb, 1)
    expect(res).toBe('图片尺寸过大')
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  }, 30000)

  it('空文件返回错误', async () => {
    const res = await uploadUserAvatar(new ArrayBuffer(0), 1)
    expect(res).toBe('上传文件不能为空')
    expect(uploadImageToS3Mock).not.toHaveBeenCalled()
  })

  it('正常图片编码并上传头像与 mini 两个变体', async () => {
    const image = await createPng(512, 512)
    const res = await uploadUserAvatar(image, 42)
    expect(res).toBeUndefined()
    expect(uploadImageToS3Mock).toHaveBeenCalledTimes(2)
  }, 30000)
})
