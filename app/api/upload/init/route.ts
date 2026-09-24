import * as z from 'zod'
import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { setKv } from '~/lib/redis'
import { presignPutObject } from '~/lib/s3'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { verifyKunCsrf } from '~/middleware/_csrf'
import {
  ALLOWED_EXTENSIONS,
  OBJECT_STORAGE_MAX_FILE_SIZE_BYTES,
  OBJECT_STORAGE_MAX_FILE_SIZE_ERROR,
  RESOURCE_DAILY_UPLOAD_LIMIT_MB
} from '~/constants/resource'
import { sanitizeFileName } from '~/utils/sanitizeFileName'
import { prisma } from '~/prisma'
import { checkKunCaptchaExist } from '~/app/api/utils/verifyKunCaptcha'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'

const MIN_FILE_SIZE = 1024
const UPLOAD_TOKEN_TTL_SECONDS = 24 * 60 * 60
const PRESIGN_TTL_SECONDS = 2 * 60 * 60

const initSchema = z.object({
  fileName: z.string().min(1).max(300),
  fileSize: z
    .number()
    .int()
    .min(MIN_FILE_SIZE, '文件过小, 您的文件小于 1 KB')
    .max(
      OBJECT_STORAGE_MAX_FILE_SIZE_BYTES - 1,
      OBJECT_STORAGE_MAX_FILE_SIZE_ERROR
    ),
  captcha: z.string().max(256).optional()
})

const getFileExtension = (filename: string) =>
  filename.slice(filename.lastIndexOf('.')).toLowerCase()

export async function POST(req: NextRequest) {
  const csrfError = verifyKunCsrf(req)
  if (csrfError) {
    return NextResponse.json(csrfError, { status: 403 })
  }

  const input = await kunParsePostBody(req, initSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未认证')
  }

  const extension = getFileExtension(input.fileName)
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return NextResponse.json(`不支持的文件类型: ${extension}`)
  }

  const user = await prisma.user.findUnique({ where: { id: payload.uid } })
  if (!user) {
    return NextResponse.json('用户未找到')
  }
  if (user.role < 2) {
    return NextResponse.json(
      '您的权限不足, 创作者或者管理员才可以上传文件到对象存储'
    )
  }
  if (user.role < 3 && user.moemoepoint < 20) {
    return NextResponse.json('仅限萌萌点大于 20 的用户才可以发布资源')
  }
  if (user.role === 2) {
    const passed = await checkKunCaptchaExist(String(input.captcha ?? ''))
    if (!passed) {
      return NextResponse.json('人机验证无效, 请完成人机验证')
    }
  }

  const fileSizeInMB = input.fileSize / (1024 * 1024)
  if (user.daily_upload_size + fileSizeInMB > RESOURCE_DAILY_UPLOAD_LIMIT_MB) {
    return NextResponse.json('您今日的上传大小已达到 5GB 限额')
  }

  const pending = await prisma.patch_resource.findFirst({
    where: { user_id: payload.uid, status: 2 }
  })
  if (pending) {
    return NextResponse.json(
      '您有至少一个 Galgame 资源在待审核阶段, 请等待审核结束后再发布资源'
    )
  }

  const sanitizedName = sanitizeFileName(input.fileName)
  const randomSegment = randomBytes(32).toString('hex')
  const s3Key = `patch/tmp/${payload.uid}/${randomSegment}/${sanitizedName}`

  const uploadUrl = await presignPutObject(
    s3Key,
    input.fileSize,
    PRESIGN_TTL_SECONDS
  )

  const token = randomBytes(24).toString('base64url')
  await setKv(
    `upload:${token}`,
    JSON.stringify({
      s3Key,
      fileName: sanitizedName,
      declared: input.fileSize,
      uid: payload.uid
    }),
    UPLOAD_TOKEN_TTL_SECONDS
  )

  return NextResponse.json({
    uploadUrl,
    token,
    expiresIn: PRESIGN_TTL_SECONDS
  })
}
