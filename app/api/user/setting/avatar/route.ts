import { randomUUID } from 'crypto'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { KUN_BODY_BUDGET } from '~/constants/bodyBudget'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { avatarSchema } from '~/validations/user'
import { purgeCloudflareCache } from '~/app/api/utils/purgeCloudflareCache'
import { archiveAvatarForModeration, uploadUserAvatar } from '../_upload'
import {
  getUserAvatarKeys,
  getUserAvatarPendingKeys
} from '~/server/storage/imageObjects'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import {
  createModerationTask,
  hasPendingModeration,
  preScreenMedia
} from '~/server/moderation/submit'
import { withDailyImageQuota } from '~/app/api/utils/imageQuota'
import { ImageRejection, admitImage } from '~/server/image/pipeline'
import type { KunActor } from '~/constants/role'

const getAvatarUrls = (uid: number) => {
  const imageBedUrl = process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL
  const keys = getUserAvatarKeys(uid)

  return {
    avatarUrl: `${imageBedUrl}/${keys.avatarKey}`,
    avatarMiniUrl: `${imageBedUrl}/${keys.avatarMiniKey}`
  }
}

const purgeCache = async (uid: number) => {
  const { avatarUrl, avatarMiniUrl } = getAvatarUrls(uid)

  return purgeCloudflareCache([avatarUrl, avatarMiniUrl])
}

const updateUserAvatar = async (actor: KunActor, avatar: ArrayBuffer) => {
  const { uid } = actor
  const user = await prisma.user.findUnique({
    where: { id: uid }
  })
  if (!user) {
    return '用户未找到'
  }
  if (await hasPendingModeration('avatar', { userId: uid })) {
    return '您提交的头像正在审核中, 暂时无法更换'
  }

  const moderation = await preScreenMedia(actor)
  if (typeof moderation === 'string') {
    return moderation
  }

  // 准入在抢额度之前: 认不出、不收的格式与像素炸弹不扣额度, 也不进编码队列
  const admitted = await admitImage(avatar)
  if (admitted instanceof ImageRejection) {
    return admitted.message
  }

  // 审核拦截时用每次上传唯一的暂存 key, 使送审读取与 apply 复制绑定同一不可变对象,
  // 并发双上传各写各的 key, 无从互相覆盖; 留档 key 复用同一 nonce, 便于按对象追溯
  const nonce = randomUUID()
  const pendingKeys = moderation.intercept
    ? getUserAvatarPendingKeys(uid, nonce)
    : undefined

  const res = await withDailyImageQuota(uid, () =>
    uploadUserAvatar(admitted, uid, pendingKeys)
  )
  if (typeof res === 'string') {
    return res
  }

  const avatarVersion = Date.now().toString(36)
  const { avatarMiniUrl } = getAvatarUrls(uid)
  const imageLink = `${avatarMiniUrl}?v=${avatarVersion}`

  const imageBedUrl = process.env.KUN_VISUAL_NOVEL_IMAGE_BED_URL
  const keys = getUserAvatarKeys(uid)

  // pendingKeys 存在 ⟺ moderation.intercept: 走暂存审核流程
  if (pendingKeys) {
    // 新头像暂存于唯一 pending key, 通过审核后由 apply.ts 复制到正式 key
    const pendingLink = `${imageBedUrl}/${pendingKeys.pendingMiniKey}?v=${avatarVersion}`
    const archiveLink = await archiveAvatarForModeration(
      pendingKeys.pendingKey,
      uid,
      nonce
    )
    const failure = await kunTx('avatar.submit', async ({ tx }) => {
      await tx.user.update({
        where: { id: uid },
        data: { avatar_status: 1 }
      })
      await createModerationTask(
        {
          contentType: 'avatar',
          userId: uid,
          payload: {
            pendingKey: pendingKeys.pendingKey,
            pendingMiniKey: pendingKeys.pendingMiniKey,
            avatarKey: keys.avatarKey,
            avatarMiniKey: keys.avatarMiniKey,
            avatarLink: imageLink,
            pendingLink,
            ...(archiveLink ? { archiveLink } : {})
          },
          dryRun: false
        },
        tx
      )
    })
    if (typeof failure === 'string') {
      return failure
    }
    await invalidateUserSession(uid)
    // pending 用每次唯一的新 key, CDN 无旧缓存可刷, 无需 purge (正式落地分支才需)

    // 显性告知作者头像审核中: 返回 pending 预览与审核标志
    return { avatar: pendingLink, pending: true }
  }

  await prisma.user.update({
    where: { id: uid },
    data: {
      avatar: imageLink,
      avatar_status: 0
    }
  })

  if (moderation.queue) {
    // dryRun: 头像直接生效, 任务仅记录 AI 裁决用于校准; 正式 key 会被后续上传覆盖,
    // 留档保证记录里是本次送审的头像
    const archiveLink = await archiveAvatarForModeration(
      keys.avatarKey,
      uid,
      nonce
    )
    await createModerationTask({
      contentType: 'avatar',
      userId: uid,
      payload: {
        pendingKey: keys.avatarKey,
        pendingMiniKey: keys.avatarMiniKey,
        avatarKey: keys.avatarKey,
        avatarMiniKey: keys.avatarMiniKey,
        avatarLink: imageLink,
        pendingLink: imageLink,
        ...(archiveLink ? { archiveLink } : {})
      },
      dryRun: true
    })
  }

  await invalidateUserSession(uid)
  // best-effort: 头像已更新成功, purge 失败不应使请求整体报错
  await purgeCache(uid).catch((error) =>
    console.error('Failed to purge avatar CDN cache:', error)
  )

  return { avatar: imageLink }
}

export const POST = kunRoute.post({
  auth: 'user',
  form: true,
  maxBytes: KUN_BODY_BUDGET.image,
  input: avatarSchema,
  handler: async ({ input, actor: payload }) => {
    const avatar = await new Response(input.avatar)?.arrayBuffer()

    return updateUserAvatar(payload, avatar)
  }
})
