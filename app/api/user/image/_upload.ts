import { uploadImageToS3 } from '~/lib/s3'
import {
  ImageRejection,
  admitImage,
  encodeVariants
} from '~/server/image/pipeline'
import type { VariantPlan } from '~/server/image/pipeline'

const INTRODUCTION_IMAGE_PLAN = {
  image: { width: 1920, height: 1080, quality: 30, maxMB: 1.007 }
} as const satisfies VariantPlan<'image'>

// key 由调用方经 newContentImageKey 取得 (server/storage/imageObjects.ts)
export const uploadIntroductionImage = async (
  key: string,
  image: ArrayBuffer
) => {
  const admitted = await admitImage(image)
  if (admitted instanceof ImageRejection) {
    return admitted.message
  }

  const encoded = await encodeVariants(admitted, INTRODUCTION_IMAGE_PLAN)
  if (encoded instanceof ImageRejection) {
    return encoded.message
  }

  await uploadImageToS3(key, encoded.image)
}
