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

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import {
  archiveAvatarForModeration,
  uploadUserAvatar
} from '~/app/api/user/setting/_upload'
import { ImageRejection, admitImage } from '~/server/image/pipeline'

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
    vi.mocked(kunLog).mockClear()
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
    const error = new Error('s3 down')
    copyObjectMock.mockRejectedValue(error)
    await expect(
      archiveAvatarForModeration('src-key', 42, 'nonce-abc')
    ).resolves.toBeUndefined()
    expect(kunLog).toHaveBeenCalledWith(
      'moderation.avatar_archive_failed',
      {},
      error
    )
  })
})

// 准入 (空文件、格式、像素炸弹) 与额度在路由: avatar/__tests__/route.test.ts、server/image/__tests__/pipeline.test.ts
describe('uploadUserAvatar', () => {
  beforeEach(() => {
    uploadImageToS3Mock.mockReset()
    uploadImageToS3Mock.mockResolvedValue(undefined)
  })

  it('正常图片编码并上传头像与 mini 两个变体', async () => {
    const image = await admitImage(await createPng(512, 512))
    if (image instanceof ImageRejection) {
      throw new Error(image.message)
    }
    const res = await uploadUserAvatar(image, 42)
    expect(res).toBeUndefined()
    expect(uploadImageToS3Mock).toHaveBeenCalledTimes(2)
  }, 30000)
})
