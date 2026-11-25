import {
  ImageRejection,
  admitImage,
  encodeVariants
} from '~/server/image/pipeline'
import type { VariantPlan } from '~/server/image/pipeline'
import type { EncodedPatchBanner } from '~/server/storage/patchBanner'

const BANNER_PLAN = {
  banner: { width: 1920, height: 1080, quality: 60, maxMB: 5 },
  miniBanner: { width: 460, height: 259, quality: 60, maxMB: 1.007 }
} as const satisfies VariantPlan<'banner' | 'miniBanner'>

const FULL_BANNER_PLAN = {
  fullBanner: { width: 3840, height: null, quality: 60, maxMB: 10 }
} as const satisfies VariantPlan<'fullBanner'>

// 校验与编码不依赖 patch id, 建档 (create.ts) 与换封面 (patch/banner/route.ts) 都在写入之前
// 先跑完: 这里所有"返回字符串即错误"的路径 (准入 / 编码限流 / 体积超限) 都发生在建行或上传
// 之前, 失败时还没有任何写入. 写入归 server/storage/patchBanner.ts
export const encodePatchBanner = async (
  image: ArrayBuffer,
  originalImage?: ArrayBuffer
): Promise<EncodedPatchBanner | string> => {
  const admittedImage = await admitImage(image)
  if (admittedImage instanceof ImageRejection) {
    return admittedImage.message
  }
  const admittedOriginal = originalImage
    ? await admitImage(originalImage)
    : undefined
  if (admittedOriginal instanceof ImageRejection) {
    return admittedOriginal.message
  }

  // 主图与原图各占一个编码槽并行
  const [main, full] = await Promise.all([
    encodeVariants(admittedImage, BANNER_PLAN),
    admittedOriginal
      ? encodeVariants(admittedOriginal, FULL_BANNER_PLAN)
      : undefined
  ])
  if (main instanceof ImageRejection) {
    return main.message
  }
  if (full instanceof ImageRejection) {
    return full.message
  }

  return { ...main, fullBanner: full?.fullBanner }
}
