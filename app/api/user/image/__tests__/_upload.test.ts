import { beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

const { uploadImageToS3Mock } = vi.hoisted(() => ({
  uploadImageToS3Mock: vi.fn()
}))

vi.mock('~/lib/s3', () => ({
  uploadImageToS3: uploadImageToS3Mock
}))

import { uploadIntroductionImage } from '../_upload'
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

// 准入 (空文件、格式、像素炸弹) 与额度在路由: route.test.ts、server/image/__tests__/pipeline.test.ts
describe('uploadIntroductionImage', () => {
  beforeEach(() => {
    uploadImageToS3Mock.mockReset()
    uploadImageToS3Mock.mockResolvedValue(undefined)
  })

  it('正常图片编码并上传单个变体', async () => {
    const image = await admitImage(await createPng(1200, 800))
    if (image instanceof ImageRejection) {
      throw new Error(image.message)
    }
    const res = await uploadIntroductionImage(
      'user/image/42/myfile.avif',
      image
    )
    expect(res).toBeUndefined()
    expect(uploadImageToS3Mock).toHaveBeenCalledTimes(1)
    // key 原样取自调用方, 这里不再自己拼
    expect(uploadImageToS3Mock.mock.calls[0][0]).toBe(
      'user/image/42/myfile.avif'
    )
  }, 30000)
})
