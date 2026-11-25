import * as z from 'zod'
import {
  OBJECT_STORAGE_MAX_FILE_SIZE_BYTES,
  OBJECT_STORAGE_MAX_FILE_SIZE_ERROR,
  RESOURCE_DAILY_UPLOAD_LIMIT_MB
} from '~/constants/resource'
import { prisma } from '~/prisma'
import { checkKunCaptchaExist } from '~/app/api/utils/verifyKunCaptcha'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { can, canPublishResource } from '~/constants/permission'
import { POINT_GATE_MESSAGE } from '~/constants/points'
import { createStagedUpload } from '~/server/storage/stagedUpload'
import {
  toSafeObjectName,
  UNSAFE_OBJECT_NAME_ERROR
} from '~/utils/safeObjectName'
import { RESOURCE_STATUS } from '~/constants/contentStatus'

const MIN_FILE_SIZE = 1024

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

export const POST = kunRoute.post({
  auth: 'user',
  input: initSchema,
  legacyDeny: { unauthenticated: '用户未认证' },
  handler: async ({ input, actor: payload }) => {
    // 名字不可用的文件在查库与消耗人机验证之前就拒掉; createStagedUpload 建对象时仍以
    // 同一份策略为准
    if (!toSafeObjectName(input.fileName)) {
      return UNSAFE_OBJECT_NAME_ERROR
    }

    const user = await prisma.user.findUnique({ where: { id: payload.uid } })
    if (!user) {
      return '用户未找到'
    }
    // 以库里此刻的角色为准, 不用会话里可能来自鉴权缓存的那份
    const uploader = { uid: user.id, role: user.role }
    if (!can(uploader, 'storage.s3')) {
      return '您的权限不足, 创作者或者管理员才可以上传文件到对象存储'
    }
    if (!canPublishResource({ ...uploader, moemoepoint: user.moemoepoint })) {
      return POINT_GATE_MESSAGE.publishResource
    }
    if (!can(uploader, 'upload.skipCaptcha')) {
      const passed = await checkKunCaptchaExist(String(input.captcha ?? ''))
      if (!passed) {
        return '人机验证无效, 请完成人机验证'
      }
    }

    const fileSizeInMB = input.fileSize / (1024 * 1024)
    if (
      user.daily_upload_size + fileSizeInMB >
      RESOURCE_DAILY_UPLOAD_LIMIT_MB
    ) {
      return '您今日的上传大小已达到 5GB 限额'
    }

    const pending = await prisma.patch_resource.findFirst({
      where: {
        user_id: payload.uid,
        status: RESOURCE_STATUS.awaitingApproval
      }
    })
    if (pending) {
      return '您有至少一个 Galgame 资源在待审核阶段, 请等待审核结束后再发布资源'
    }

    return createStagedUpload({
      uid: payload.uid,
      fileName: input.fileName,
      fileSize: input.fileSize
    })
  }
})
