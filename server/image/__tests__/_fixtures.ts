import { crc32, deflateSync } from 'node:zlib'
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

// 只有文件头声明 20000×20000 (400MP) 的 PNG: 超过 sharp 默认的约 268MP 输入上限
export const createDeclaredHugePng = () => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(20000, 0)
  header.writeUInt32BE(20000, 4)
  header[8] = 8 // 位深
  header[9] = 2 // RGB
  return toArrayBuffer(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.alloc(64))),
      chunk('IEND', Buffer.alloc(0))
    ])
  )
}

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

// 以 AVIF 的 ftyp 字样开头的 SVG: 按内容识别仍是 svg
export const createDisguisedSvg = () =>
  toArrayBuffer(
    Buffer.concat([Buffer.from('<!--ftypavif-->'), Buffer.from(createSvg())])
  )

export const createTiff = async () =>
  toArrayBuffer(
    await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#336699' }
    })
      .tiff()
      .toBuffer()
  )

// macOS 的 sips 由 64×48 纯色 PNG 转出的 HEIC (heif + hevc)。sharp 能读文件头, 预编译的
// libheif 不带 HEVC 解码器, 真正解码时抛错; sharp 自己也编不出 HEVC, 所以内嵌字节
export const createHeic = () =>
  toArrayBuffer(
    Buffer.from(
      'AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABw21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5mlwcnAAAADFaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAABAAAAAMAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABxaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAjQgEBA3AAAAMAsAAAAwAAAwAeoBQgQcGMTiHuRZVNwICBgCCiAAEACUQBwGFyyEBTJAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAsaWxvYwAAAABEAAACAAEAAAABAAACQwAAAC8AAgAAAAEAAAH3AAAATAAAAAFtZGF0AAAAAAAAAIsAAAAGRXhpZgAATU0AKgAAAAgAAwEaAAUAAAABAAAAMgEbAAUAAAABAAAAOgEoAAMAAAABAAIAAAAAAAAAAAAZAAAAAQAAABkAAAABAAAAKygBr6L2RoF8//zGZ6/0l//8sfPsNrRPWX+/9q9b+dJP6f/QPm4HCZqbVH4=',
      'base64'
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
