import sharp from 'sharp'

import { MAX_QUEUE_DEPTH, withEncodeSlot } from '~/server/image/encodeLimit'

const toArrayBuffer = (buf: Buffer) =>
  buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength
  ) as ArrayBuffer

export const createPng = async (width: number, height: number) =>
  toArrayBuffer(
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 100, g: 150, b: 200 }
      }
    })
      .png()
      .toBuffer()
  )

// 56MP, 超过 MAX_IMAGE_PIXELS (50MP); 纯色所以文件很小, 正是「像素炸弹」的形状
export const createPixelBomb = () => createPng(8000, 7000)

// 文件头完整、像素数据只剩一半: metadata() 能读出尺寸, 真正解码时才抛错
export const createTruncatedPng = async () => {
  const png = Buffer.from(await createPng(640, 480))
  return toArrayBuffer(png.subarray(0, Math.floor(png.length / 2)))
}

export const createGarbage = () =>
  toArrayBuffer(Buffer.from('definitely not an image, just some bytes'))

export const createSvg = () =>
  toArrayBuffer(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48"/></svg>'
    )
  )

// 两个槽位加满等待队列: 之后的 acquire 立刻以 EncodeBusyError 拒绝。返回放行函数
export const saturateEncodeQueue = async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = Array.from({ length: 2 + MAX_QUEUE_DEPTH }, () =>
    withEncodeSlot(() => gate)
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  return async () => {
    release()
    await Promise.allSettled(held)
  }
}
