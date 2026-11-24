import sharp from 'sharp'

import { uploadImageToS3 } from '~/lib/s3'
import { checkBufferSize } from '~/app/api/utils/checkBufferSize'
import { withEncodeSlotOrBusy } from '~/server/image/encodeLimit'
import { ensureWithinPixelLimit } from '~/server/image/pixelGuard'

// key 由调用方经 newContentImageKey 取得 (server/storage/imageObjects.ts)
export const uploadIntroductionImage = async (
  key: string,
  image: ArrayBuffer
) => {
  if (image.byteLength === 0) {
    return '上传文件不能为空'
  }

  const pixelError = await ensureWithinPixelLimit(image)
  if (pixelError) {
    return pixelError
  }

  const minImage = await withEncodeSlotOrBusy(() =>
    sharp(image)
      .resize(1920, 1080, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .avif({ quality: 30 })
      .toBuffer()
  )

  if (typeof minImage === 'string') {
    return minImage
  }

  if (!checkBufferSize(minImage, 1.007)) {
    return '图片体积过大'
  }

  await uploadImageToS3(key, minImage)
}
