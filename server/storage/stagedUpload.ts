import * as z from 'zod'
import { randomBytes } from 'crypto'
import { delKv, getKv, setKv } from '~/lib/redis'
import { deleteFileFromS3, headObject, presignPutObject } from '~/lib/s3'
import {
  OBJECT_STORAGE_MAX_FILE_SIZE_BYTES,
  OBJECT_STORAGE_MAX_FILE_SIZE_ERROR
} from '~/constants/resource'
import { sanitizeFileName } from '~/utils/sanitizeFileName'

// 资源直传的「暂存 → 转正」边界 (T19)。上传者只决定字节: 暂存对象叫什么、令牌里记什么、
// 对象够不够格转正, 都只在这个模块里定。init / complete 路由与 bindUploadedResource 是它
// 仅有的三个调用方; 上传会话仍是 Redis 里的一枚令牌, 没有持久化状态

const STAGING_PREFIX = 'patch/tmp/'
const UPLOAD_TOKEN_TTL_SECONDS = 24 * 60 * 60
const PRESIGN_TTL_SECONDS = 2 * 60 * 60

const UPLOAD_TOKEN_MISSING = '上传 token 已过期或不存在, 请重新上传文件'

const uploadTokenMetaSchema = z.object({
  s3Key: z.string().startsWith(STAGING_PREFIX),
  fileName: z.string().min(1),
  declared: z.number().int().positive(),
  uid: z.number().int().positive()
})

export type UploadTokenMeta = z.infer<typeof uploadTokenMetaSchema>

const uploadTokenKey = (token: string) => `upload:${token}`

export const createStagedUpload = async (input: {
  uid: number
  fileName: string
  fileSize: number
}) => {
  const fileName = sanitizeFileName(input.fileName)
  const segment = randomBytes(32).toString('hex')
  const s3Key = `${STAGING_PREFIX}${input.uid}/${segment}/${fileName}`

  const uploadUrl = await presignPutObject(
    s3Key,
    input.fileSize,
    PRESIGN_TTL_SECONDS
  )

  const token = randomBytes(24).toString('base64url')
  const meta: UploadTokenMeta = {
    s3Key,
    fileName,
    declared: input.fileSize,
    uid: input.uid
  }
  await setKv(
    uploadTokenKey(token),
    JSON.stringify(meta),
    UPLOAD_TOKEN_TTL_SECONDS
  )

  return { uploadUrl, token, expiresIn: PRESIGN_TTL_SECONDS }
}

// 令牌内容损坏或形状不对与令牌不存在同样处理: 调用方拿到的要么是校验过的元数据, 要么是文案
export const readUploadToken = async (
  token: string,
  uid: number
): Promise<UploadTokenMeta | string> => {
  const raw = await getKv(uploadTokenKey(token))
  if (!raw) {
    return UPLOAD_TOKEN_MISSING
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return UPLOAD_TOKEN_MISSING
  }
  const parsed = uploadTokenMetaSchema.safeParse(json)
  if (!parsed.success) {
    return UPLOAD_TOKEN_MISSING
  }
  if (parsed.data.uid !== uid) {
    return '上传 token 不属于当前用户'
  }
  return parsed.data
}

// 被拒绝的上传不留给下一次请求: 暂存对象与令牌一起清掉, 清理失败不改变拒绝结果
export const discardStagedUpload = async (
  token: string,
  meta: UploadTokenMeta
) => {
  await deleteFileFromS3(meta.s3Key).catch(() => undefined)
  await delKv(uploadTokenKey(token)).catch(() => undefined)
}

// HEAD 不到对象时令牌与暂存都留着 (上传可能还没结束, 也可能是存储一时不可用);
// 大小对不上或超限的对象不可能再变合格, 当场清掉
export const verifyStagedObject = async (
  token: string,
  meta: UploadTokenMeta
): Promise<{ size: number } | string> => {
  const info = await headObject(meta.s3Key).catch(() => null)
  if (!info) {
    return '文件未上传成功, 请重新上传'
  }

  const size = Number(info.ContentLength ?? 0)
  if (size !== meta.declared) {
    await discardStagedUpload(token, meta)
    return '文件大小不一致, 请重新上传'
  }
  if (size >= OBJECT_STORAGE_MAX_FILE_SIZE_BYTES) {
    await discardStagedUpload(token, meta)
    return OBJECT_STORAGE_MAX_FILE_SIZE_ERROR
  }
  return { size }
}
