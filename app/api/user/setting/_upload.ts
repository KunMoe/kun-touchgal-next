import sharp from 'sharp'

import { copyObject, uploadImageToS3 } from '~/lib/s3'
import { checkBufferSize } from '~/app/api/utils/checkBufferSize'
import { withEncodeSlotOrBusy } from '~/server/image/encodeLimit'
import { ensureWithinPixelLimit } from '~/server/image/pixelGuard'
import { MODERATION_S3_TIMEOUT_MS } from '~/constants/moderation'
import {
  getUserAvatarKeys,
  getUserAvatarModerationArchiveKey
} from '~/server/storage/imageObjects'

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
  if (image.byteLength === 0) {
    return '上传文件不能为空'
  }

  const pixelError = await ensureWithinPixelLimit(image)
  if (pixelError) {
    return pixelError
  }

  const encoded = await withEncodeSlotOrBusy(async () => {
    const avatar = await sharp(image)
      .resize(256, 256, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .avif({ quality: 60 })
      .toBuffer()
    const miniAvatar = await sharp(image)
      .resize(100, 100, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .avif({ quality: 50 })
      .toBuffer()
    return { avatar, miniAvatar }
  })

  if (typeof encoded === 'string') {
    return encoded
  }
  const { avatar, miniAvatar } = encoded

  if (!checkBufferSize(avatar, 1.007)) {
    return '图片体积过大'
  }

  if (pendingKeys) {
    await uploadImageToS3(pendingKeys.pendingKey, avatar)
    await uploadImageToS3(pendingKeys.pendingMiniKey, miniAvatar)
  } else {
    const keys = getUserAvatarKeys(uid)
    await uploadImageToS3(keys.avatarKey, avatar)
    await uploadImageToS3(keys.avatarMiniKey, miniAvatar)
  }
}
