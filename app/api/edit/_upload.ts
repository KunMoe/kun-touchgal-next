import sharp from 'sharp'

import { checkBufferSize } from '~/app/api/utils/checkBufferSize'
import { withEncodeSlotOrBusy } from '~/server/image/encodeLimit'
import { ensureWithinPixelLimit } from '~/server/image/pixelGuard'
import type { EncodedPatchBanner } from '~/server/storage/patchBanner'

// 校验与编码不依赖 patch id, 建档 (create.ts) 与换封面 (patch/banner/route.ts) 都在写入之前
// 先跑完: 这里所有"返回字符串即错误"的路径 (像素守卫 / 编码限流 / 体积超限) 都发生在建行或上传
// 之前, 失败时还没有任何写入. 写入归 server/storage/patchBanner.ts
export const encodePatchBanner = async (
  image: ArrayBuffer,
  originalImage?: ArrayBuffer
): Promise<EncodedPatchBanner | string> => {
  if (image.byteLength === 0) {
    return '上传文件不能为空'
  }
  if (originalImage && originalImage.byteLength === 0) {
    return '上传文件不能为空'
  }

  const imagePixelError = await ensureWithinPixelLimit(image)
  if (imagePixelError) {
    return imagePixelError
  }
  if (originalImage) {
    const originalPixelError = await ensureWithinPixelLimit(originalImage)
    if (originalPixelError) {
      return originalPixelError
    }
  }

  const encodeFull = originalImage
    ? withEncodeSlotOrBusy(() =>
        sharp(originalImage)
          .resize(3840, null, {
            fit: 'inside',
            withoutEnlargement: true
          })
          .avif({ quality: 60 })
          .toBuffer()
      )
    : undefined

  const [main, fullBanner] = await Promise.all([
    withEncodeSlotOrBusy(async () => {
      const banner = await sharp(image)
        .resize(1920, 1080, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .avif({ quality: 60 })
        .toBuffer()
      const miniBanner = await sharp(image)
        .resize(460, 259, {
          fit: 'inside',
          withoutEnlargement: true
        })
        .avif({ quality: 60 })
        .toBuffer()
      return { banner, miniBanner }
    }),
    encodeFull
  ])

  if (typeof main === 'string') {
    return main
  }
  if (typeof fullBanner === 'string') {
    return fullBanner
  }
  const { banner, miniBanner } = main

  if (!checkBufferSize(banner, 5)) {
    return '图片体积过大'
  }
  if (!checkBufferSize(miniBanner, 1.007)) {
    return '图片体积过大'
  }
  if (fullBanner && !checkBufferSize(fullBanner, 10)) {
    return '图片体积过大'
  }

  return { banner, miniBanner, fullBanner }
}
