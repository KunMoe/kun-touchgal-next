import sharp from 'sharp'

import { uploadImageToS3 } from '~/lib/s3'
import { checkBufferSize } from '~/app/api/utils/checkBufferSize'
import { withEncodeSlotOrBusy } from '~/server/image/encodeLimit'
import { ensureWithinPixelLimit } from '~/server/image/pixelGuard'

export interface EncodedPatchBanner {
  banner: Buffer
  miniBanner: Buffer
  fullBanner?: Buffer
}

// 校验与编码不依赖 patch id, 拆出来供 create.ts 在事务外先跑完: 这里所有"返回字符串即
// 错误"的路径 (像素守卫 / 编码限流 / 体积超限) 都发生在建行之前, 失败时还没有任何写入.
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

// PUT 与事务回滚后的补偿清理 (create.ts) 共用同一份 key 拼接, 防两处字符串漂移
export const buildPatchBannerKeys = (id: number, hasFull: boolean) => {
  const prefix = `patch/${id}/banner`
  const keys = [`${prefix}/banner.avif`, `${prefix}/banner-mini.avif`]
  if (hasFull) {
    keys.push(`${prefix}/banner-full.avif`)
  }
  return keys
}

// 只做 S3 PUT, 失败直接抛出: 事务内调用时靠抛出触发回滚, 不会留下孤儿 patch 行.
export const putPatchBannerToS3 = async (
  encoded: EncodedPatchBanner,
  id: number
) => {
  const [bannerKey, miniKey, fullKey] = buildPatchBannerKeys(
    id,
    Boolean(encoded.fullBanner)
  )

  const uploadTasks = [
    uploadImageToS3(bannerKey, encoded.banner),
    uploadImageToS3(miniKey, encoded.miniBanner)
  ]

  if (encoded.fullBanner) {
    uploadTasks.push(uploadImageToS3(fullKey, encoded.fullBanner))
  }

  await Promise.all(uploadTasks)
}

export const uploadPatchBanner = async (
  image: ArrayBuffer,
  id: number,
  originalImage?: ArrayBuffer
) => {
  const encoded = await encodePatchBanner(image, originalImage)
  if (typeof encoded === 'string') {
    return encoded
  }

  await putPatchBannerToS3(encoded, id)
}
