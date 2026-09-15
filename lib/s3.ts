import { dirname } from 'path'
import { S3Client } from '@aws-sdk/client-s3'
import { readFile, rm } from 'fs/promises'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export const s3 = new S3Client({
  endpoint: process.env.KUN_VISUAL_NOVEL_S3_STORAGE_ENDPOINT!,
  region: process.env.KUN_VISUAL_NOVEL_S3_STORAGE_REGION!,
  credentials: {
    accessKeyId: process.env.KUN_VISUAL_NOVEL_S3_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: process.env.KUN_VISUAL_NOVEL_S3_STORAGE_SECRET_ACCESS_KEY!
  },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  // 全局兜底: connectionTimeout 覆盖连不上, socketTimeout 覆盖连上后 S3 黑洞 (长时间
  // 不吐数据). 刻意不设 requestTimeout —— 该版本 (client-s3 3.1030) 的 requestTimeout
  // 是整请求的墙钟总时长且需 throwOnRequestTimeout 才中断, 会误杀 server 端大文件上传;
  // 需要墙钟上限的调用方 (moderation get/copy、resource copy) 自带 per-call
  // AbortSignal.timeout, 与此处独立叠加, 取先触发者
  requestHandler: {
    connectionTimeout: 5_000,
    socketTimeout: 60_000
  }
})

const Bucket = process.env.KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME!

export const uploadImageToS3 = async (key: string, fileBuffer: Buffer) => {
  const uploadCommand = new PutObjectCommand({
    Bucket: process.env.KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME!,
    Key: key,
    Body: fileBuffer,
    ContentType: 'application/octet-stream'
  })
  await s3.send(uploadCommand)
}

export const uploadFileToS3 = async (key: string, filePath: string) => {
  const fileBuffer = await readFile(filePath)
  const uploadCommand = new PutObjectCommand({
    Bucket: process.env.KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME!,
    Key: key,
    Body: fileBuffer,
    ContentType: 'application/octet-stream'
  })
  await s3.send(uploadCommand)

  const folderPath = dirname(filePath)
  await rm(folderPath, { recursive: true, force: true })
}

export const getFileFromS3 = async (key: string, abortSignal?: AbortSignal) => {
  const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }), {
    abortSignal
  })
  const bytes = await res.Body?.transformToByteArray()
  if (!bytes) {
    throw new Error(`Empty S3 object body for key: ${key}`)
  }
  return Buffer.from(bytes)
}

export const deleteFileFromS3 = async (key: string) => {
  const deleteCommand = new DeleteObjectCommand({
    Bucket: process.env.KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME!,
    Key: key
  })
  await s3.send(deleteCommand)
}

export const presignPutObject = (
  key: string,
  contentLength: number,
  expiresIn = 2 * 60 * 60
) =>
  getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket,
      Key: key,
      ContentLength: contentLength,
      ContentType: 'application/octet-stream'
    }),
    { expiresIn }
  )

export const headObject = (key: string) =>
  s3.send(new HeadObjectCommand({ Bucket, Key: key }))

export const copyObject = (
  srcKey: string,
  dstKey: string,
  abortSignal?: AbortSignal
) =>
  s3.send(
    new CopyObjectCommand({
      Bucket,
      CopySource: `${Bucket}/${encodeURI(srcKey)}`,
      Key: dstKey
    }),
    { abortSignal }
  )
