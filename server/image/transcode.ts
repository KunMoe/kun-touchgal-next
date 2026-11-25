import sharp from 'sharp'

import { withEncodeSlot } from './encodeLimit'

// 只给服务端自己产出的 AVIF 用 (头像审核把暂存对象转成 JPEG 送视觉模型): 输入已经过上传管线,
// 不再准入。与上传共用同一个有界编码槽: 队列满或排队超时会抛 EncodeBusyError, 由审核 worker
// 按失败归因处理 (与改动前相同)
export const transcodeTrustedAvifToJpeg = (buffer: Buffer) =>
  withEncodeSlot(() => sharp(buffer).jpeg({ quality: 85 }).toBuffer())
