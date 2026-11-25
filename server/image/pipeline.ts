import sharp from 'sharp'

import { MAX_IMAGE_PIXELS } from '~/validations/file'
import { EncodeBusyError, withEncodeSlot } from './encodeLimit'

// 上传图片的唯一处理管线: 准入 (admitImage) → 规格化编码 (encodeVariants)。额度归
// app/api/utils/imageQuota.ts 的 withDailyImageQuota, key 与 S3 写入归各入口。
// 每一种失败都带出它发生在哪个阶段: 路由据此决定退不退额度, 不再从字符串猜

// billable: 这次失败已经消耗了解码或编码资源, 应归因于输入 (不退额度)。
// 仿照 EncodeBusyError 的先例, 用 instanceof 判别
export class ImageRejection {
  constructor(
    readonly message: string,
    readonly billable: boolean
  ) {}
}

declare const admitted: unique symbol

// 只能由 admitImage 产出: encodeVariants 只收它, 未经准入的字节进不了编码
export interface AdmittedImage {
  readonly [admitted]: true
  readonly input: ArrayBuffer
  readonly width: number
  readonly height: number
}

// 编码前的廉价护栏: metadata() 只读文件头、不解码像素, 用它在真正解码之前拦掉高压缩比
// 「像素炸弹」(声明尺寸巨大、压缩后体积却很小的图), 避免 ≤10MB 的上传解码成近 GB 级位图。
// 所有拒绝都发生在进编码槽、扣额度之前
export const admitImage = async (
  input: ArrayBuffer
): Promise<AdmittedImage | ImageRejection> => {
  if (input.byteLength === 0) {
    return new ImageRejection('上传文件不能为空', false)
  }
  const { width, height } = await sharp(input).metadata()
  if (!width || !height) {
    return new ImageRejection('无法解析图片尺寸', false)
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    return new ImageRejection('图片尺寸过大', false)
  }
  return { input, width, height } as AdmittedImage
}

// 一个变体: 等比缩进 width × height 之内 (height 为 null 时只限宽), 不放大, 编成 AVIF。
// maxMB 必填: 每个变体都有体积上限, 漏检写不出来
export interface VariantSpec {
  readonly width: number
  readonly height: number | null
  readonly quality: number
  readonly maxMB: number
}

export type VariantPlan<K extends string> = Readonly<Record<K, VariantSpec>>

const BYTES_PER_MB = 1024 * 1024

// 一次调用只占一个编码槽 (有界队列, 满或排队超时即拒绝), 槽内逐个变体从原始字节独立解码。
// 不复用 .raw() 中间结果: 8-bit 非预乘中转对带 alpha 的图有损 (sharp-raw-roundtrip-alpha-lossy)。
// 要并行就调用两次 (封面的主图与原图), 不加槽位开关
export const encodeVariants = async <K extends string>(
  image: AdmittedImage,
  plan: VariantPlan<K>
): Promise<Record<K, Buffer> | ImageRejection> => {
  try {
    return await withEncodeSlot(async () => {
      const encoded = {} as Record<K, Buffer>
      for (const name of Object.keys(plan) as K[]) {
        const { width, height, quality, maxMB } = plan[name]
        const buffer = await sharp(image.input, {
          limitInputPixels: MAX_IMAGE_PIXELS
        })
          .resize(width, height, { fit: 'inside', withoutEnlargement: true })
          .avif({ quality })
          .toBuffer()
        if (buffer.length > maxMB * BYTES_PER_MB) {
          return new ImageRejection('图片体积过大', false)
        }
        encoded[name] = buffer
      }
      return encoded
    })
  } catch (error) {
    if (error instanceof EncodeBusyError) {
      return new ImageRejection(error.message, false)
    }
    throw error
  }
}
