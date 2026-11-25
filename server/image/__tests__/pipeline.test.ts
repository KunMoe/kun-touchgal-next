import { describe, expect, it } from 'vitest'
import sharp from 'sharp'

import {
  ImageRejection,
  admitImage,
  encodeVariants
} from '~/server/image/pipeline'
import { createPixelBomb, createPng, saturateEncodeQueue } from './_fixtures'

const admit = async (input: ArrayBuffer) => {
  const image = await admitImage(input)
  if (image instanceof ImageRejection) {
    throw new Error(image.message)
  }
  return image
}

describe('admitImage', () => {
  it('空文件拒绝', async () => {
    expect(await admitImage(new ArrayBuffer(0))).toEqual(
      new ImageRejection('上传文件不能为空', false)
    )
  })

  it('像素数超过上限时拒绝, 不计费', async () => {
    expect(await admitImage(await createPixelBomb())).toEqual(
      new ImageRejection('图片尺寸过大', false)
    )
  }, 30000)

  it('放行时带出原始字节与尺寸', async () => {
    const input = await createPng(320, 200)
    const image = await admit(input)
    expect(image.input).toBe(input)
    expect([image.width, image.height]).toEqual([320, 200])
  })
})

describe('encodeVariants', () => {
  it('每个变体等比缩进各自的框内、不放大, 编成 AVIF', async () => {
    const image = await admit(await createPng(1000, 500))
    const res = await encodeVariants(image, {
      small: { width: 100, height: 100, quality: 50, maxMB: 1 },
      wide: { width: 3840, height: null, quality: 50, maxMB: 1 }
    })
    if (res instanceof ImageRejection) {
      throw new Error(res.message)
    }
    const small = await sharp(res.small).metadata()
    const wide = await sharp(res.wide).metadata()
    expect([small.format, small.width, small.height]).toEqual(['heif', 100, 50])
    expect([wide.width, wide.height]).toEqual([1000, 500])
  })

  it('任何一个变体超过体积上限都拒绝', async () => {
    const image = await admit(await createPng(400, 300))
    const res = await encodeVariants(image, {
      first: { width: 400, height: 300, quality: 50, maxMB: 1 },
      second: { width: 400, height: 300, quality: 50, maxMB: 0.0001 }
    })
    expect(res).toEqual(new ImageRejection('图片体积过大', false))
  })

  it('编码排队已满时拒绝, 不计费', async () => {
    const image = await admit(await createPng(64, 64))
    const release = await saturateEncodeQueue()
    try {
      expect(
        await encodeVariants(image, {
          only: { width: 64, height: 64, quality: 50, maxMB: 1 }
        })
      ).toEqual(new ImageRejection('服务器繁忙, 请稍后重试', false))
    } finally {
      await release()
    }
  })

  it('类型上只收经过准入的图片 (由 pnpm typecheck 执法)', () => {
    const forged = { input: new ArrayBuffer(8), width: 1, height: 1 }
    const plan = { only: { width: 1, height: 1, quality: 1, maxMB: 1 } }
    // @ts-expect-error 没经过 admitImage 的对象不是 AdmittedImage
    const call = () => encodeVariants(forged, plan)
    expect(call).toBeTypeOf('function')
  })
})
