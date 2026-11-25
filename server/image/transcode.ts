import sharp from 'sharp'

import { withEncodeSlot } from './encodeLimit'

// 只给服务端自己产出的 AVIF 用 (头像审核把暂存对象转成 JPEG 送视觉模型): 输入已经过上传管线,
// 不再准入。用不带背压的 withEncodeSlot, 并发由 MODERATION_BATCH_SIZE 约束
export const transcodeTrustedAvifToJpeg = (buffer: Buffer) =>
  withEncodeSlot(() => sharp(buffer).jpeg({ quality: 85 }).toBuffer())
