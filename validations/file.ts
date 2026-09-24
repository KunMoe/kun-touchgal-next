import * as z from 'zod'

const isBlobLike = (value: unknown): value is Blob =>
  typeof Blob !== 'undefined' && value instanceof Blob

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024

// 像素总数 (宽 × 高) 上限: 10MB 字节上限约束不了解码开销, 高压缩比图片可解码成
// 近 268MP (sharp 默认 limitInputPixels) 的炸弹; 收紧到 50MP, 远大于 3840×2160=8.3MP 的正常原图
export const MAX_IMAGE_PIXELS = 50 * 1000 * 1000

export const nonEmptyFileSchema = z
  .custom<Blob>((value) => isBlobLike(value), {
    message: '请上传文件'
  })
  .refine((file) => file.size > 0, {
    message: '上传文件不能为空'
  })
  .refine((file) => file.size <= MAX_IMAGE_SIZE_BYTES, {
    message: '图片大小不能超过 10 MB'
  })
