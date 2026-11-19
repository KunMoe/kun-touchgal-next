import * as z from 'zod'
import { delKv, getKv } from '~/lib/redis'
import { deleteFileFromS3, headObject } from '~/lib/s3'
import { kunRoute } from '~/app/api/utils/kunRoute'
import {
  OBJECT_STORAGE_MAX_FILE_SIZE_BYTES,
  OBJECT_STORAGE_MAX_FILE_SIZE_ERROR
} from '~/constants/resource'

const completeSchema = z.object({
  token: z.string().min(8).max(128)
})

interface UploadTokenMeta {
  s3Key: string
  fileName: string
  declared: number
  uid: number
}

const cleanupRejectedUpload = async (token: string, s3Key: string) => {
  await deleteFileFromS3(s3Key).catch(() => undefined)
  await delKv(`upload:${token}`).catch(() => undefined)
}

export const POST = kunRoute.post({
  auth: 'user',
  csrf: 'handler',
  input: completeSchema,
  legacyDeny: { unauthenticated: '用户未认证' },
  handler: async ({ input, actor: payload }) => {
    const raw = await getKv(`upload:${input.token}`)
    if (!raw) {
      return '上传 token 已过期或不存在, 请重新上传'
    }

    const meta = JSON.parse(raw) as UploadTokenMeta
    if (meta.uid !== payload.uid) {
      return '上传 token 不属于当前用户'
    }

    const info = await headObject(meta.s3Key).catch(() => null)
    if (!info) {
      return '文件未上传成功, 请重试'
    }

    const actualSize = Number(info.ContentLength ?? 0)
    if (actualSize !== meta.declared) {
      await cleanupRejectedUpload(input.token, meta.s3Key)
      return '文件大小不一致, 请重新上传'
    }
    if (actualSize >= OBJECT_STORAGE_MAX_FILE_SIZE_BYTES) {
      await cleanupRejectedUpload(input.token, meta.s3Key)
      return OBJECT_STORAGE_MAX_FILE_SIZE_ERROR
    }

    const fileSizeMB = actualSize / (1024 * 1024)

    return {
      filetype: 's3',
      fileToken: input.token,
      fileSize: `${fileSizeMB.toFixed(3)} MB`
    }
  }
})
