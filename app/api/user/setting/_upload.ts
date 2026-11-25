import { copyObject, uploadImageToS3 } from '~/lib/s3'
import {
  ImageRejection,
  admitImage,
  encodeVariants
} from '~/server/image/pipeline'
import type { VariantPlan } from '~/server/image/pipeline'
import { MODERATION_S3_TIMEOUT_MS } from '~/constants/moderation'
import {
  getUserAvatarKeys,
  getUserAvatarModerationArchiveKey
} from '~/server/storage/imageObjects'

const AVATAR_PLAN = {
  avatar: { width: 256, height: 256, quality: 60, maxMB: 1.007 },
  miniAvatar: { width: 100, height: 100, quality: 50, maxMB: 1.007 }
} as const satisfies VariantPlan<'avatar' | 'miniAvatar'>

// 审核留档: 把送审对象复制到每次上传唯一的永久 key. 裁决后 pending 暂存对象会被
// apply.ts 清理、正式 key 会被后续上传覆盖, 留档使管理队列的审核记录始终可回看;
// 复制失败不阻断头像上传主流程 (返回 undefined, payload 省略字段), 仅该条记录
// 退化为裁决后无法显示
export const archiveAvatarForModeration = async (
  srcKey: string,
  uid: number,
  nonce: string
) => {
  const archiveKey = getUserAvatarModerationArchiveKey(uid, nonce)
  try {
    await copyObject(
      srcKey,
      archiveKey,
      AbortSignal.timeout(MODERATION_S3_TIMEOUT_MS)
    )
    return `${process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL}/${archiveKey}`
  } catch (error) {
    console.error('Failed to archive moderation avatar:', error)
    return undefined
  }
}

export const uploadUserAvatar = async (
  image: ArrayBuffer,
  uid: number,
  // 审核开启时先上传到唯一暂存 key (getUserAvatarPendingKeys), 通过后由 apply.ts
  // 复制到正式 key; 不传则直接写正式 key
  pendingKeys?: { pendingKey: string; pendingMiniKey: string }
) => {
  const admitted = await admitImage(image)
  if (admitted instanceof ImageRejection) {
    return admitted.message
  }

  const encoded = await encodeVariants(admitted, AVATAR_PLAN)
  if (encoded instanceof ImageRejection) {
    return encoded.message
  }
  const { avatar, miniAvatar } = encoded

  if (pendingKeys) {
    await uploadImageToS3(pendingKeys.pendingKey, avatar)
    await uploadImageToS3(pendingKeys.pendingMiniKey, miniAvatar)
  } else {
    const keys = getUserAvatarKeys(uid)
    await uploadImageToS3(keys.avatarKey, avatar)
    await uploadImageToS3(keys.avatarMiniKey, miniAvatar)
  }
}
