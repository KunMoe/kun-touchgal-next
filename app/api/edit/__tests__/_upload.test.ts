import { describe, expect, it } from 'vitest'
import sharp from 'sharp'

import { encodePatchBanner } from '../_upload'

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

// 写入 (版本目录与 S3 PUT) 见 server/storage/__tests__/patchBanner.test.ts
describe('encodePatchBanner', () => {
  it('原图像素数超过上限时前置拒绝, 不触发编码', async () => {
    const bomb = await createPng(8000, 7000) // 56M > 50M 上限
    expect(await encodePatchBanner(bomb)).toBe('图片尺寸过大')
  }, 30000)

  it('空文件返回错误', async () => {
    expect(await encodePatchBanner(new ArrayBuffer(0))).toBe('上传文件不能为空')
  })

  it('正常图片编出三个变体, full 变体被限制在 3840 宽以内', async () => {
    const image = await createPng(3900, 100)
    const res = await encodePatchBanner(image, image)
    if (typeof res === 'string') {
      throw new Error(res)
    }
    expect(res.banner.length).toBeGreaterThan(0)
    expect(res.miniBanner.length).toBeGreaterThan(0)
    const fullMeta = await sharp(res.fullBanner).metadata()
    expect(fullMeta.width).toBeLessThanOrEqual(3840)
  }, 30000)

  it('不带原图时没有 full 变体', async () => {
    const res = await encodePatchBanner(await createPng(400, 300))
    expect(typeof res === 'object' && res.fullBanner).toBeUndefined()
  }, 30000)
})
