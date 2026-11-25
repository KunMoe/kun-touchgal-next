import { uploadImageToS3 } from '~/lib/s3'
import { ImageRejection, encodeVariants } from '~/server/image/pipeline'
import type { AdmittedImage, VariantPlan } from '~/server/image/pipeline'

const INTRODUCTION_IMAGE_PLAN = {
  image: { width: 1920, height: 1080, quality: 30, maxMB: 1.007 }
} as const satisfies VariantPlan<'image'>

// key 由调用方经 newContentImageKey 取得 (server/storage/imageObjects.ts); 准入与额度归路由
export const uploadIntroductionImage = async (
  key: string,
  image: AdmittedImage
) => {
  const encoded = await encodeVariants(image, INTRODUCTION_IMAGE_PLAN)
  if (encoded instanceof ImageRejection) {
    return encoded
  }

  await uploadImageToS3(key, encoded.image)
}
