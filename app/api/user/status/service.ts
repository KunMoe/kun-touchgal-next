import { prisma } from '~/prisma/index'
import { getRedirectConfig } from '~/app/api/admin/setting/redirect/getRedirectConfig'
import { getModerationConfig } from '~/server/moderation/config'
import { decodeModerationTask } from '~/server/moderation/taskCodec'
import type { UserState } from '~/types/api/session'

// 本人视角合并审核中的头像/签名暂存值, 保证提交后刷新页面显示一致
const getPendingProfileValues = async (uid: number) => {
  // 审核关闭时不产生新任务, 跳过查询避免会话路径的额外开销
  const config = await getModerationConfig()
  if (!config.enabled) {
    return { pendingAvatar: undefined, pendingBio: undefined }
  }

  const pendingTasks = await prisma.moderation_task.findMany({
    where: {
      user_id: uid,
      // 与 hasPendingModeration 对齐: 转人工 (manual) 期间仍向作者展示送审新值,
      // 避免锁定生效但预览回退旧值的错位
      status: { in: ['pending', 'manual'] },
      dry_run: false,
      content_type: { in: ['avatar', 'bio'] }
    },
    orderBy: { created: 'desc' }
  })

  const avatarTask = pendingTasks.find((t) => t.content_type === 'avatar')
  const bioTask = pendingTasks.find((t) => t.content_type === 'bio')
  const avatarBody = avatarTask ? decodeModerationTask(avatarTask) : null
  const bioBody = bioTask ? decodeModerationTask(bioTask) : null

  return {
    pendingAvatar:
      avatarBody?.contentType === 'avatar'
        ? avatarBody.payload.pendingLink
        : undefined,
    pendingBio: bioBody?.contentType === 'bio' ? bioBody.bio : undefined
  }
}

export const getUserStatus = async (uid: number) => {
  // 三者仅依赖 uid、互不依赖: 并行拉取以缩短会话缓存未命中路径的串行长度。
  // null / status===2 的早退在结果就绪后判定, 代价是错误路径多跑 pending/redirect (罕见)
  const [user, { pendingAvatar, pendingBio }, redirectConfig] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: uid },
        select: {
          id: true,
          name: true,
          avatar: true,
          bio: true,
          moemoepoint: true,
          role: true,
          status: true,
          daily_check_in: true,
          daily_image_count: true,
          daily_upload_size: true,
          enable_email_notice: true,
          allow_private_message: true,
          blocked_tag_ids: true
        }
      }),
      getPendingProfileValues(uid),
      getRedirectConfig()
    ])
  if (!user) {
    return '用户未找到'
  }
  if (user.status === 2) {
    return '用户登录失效'
  }
  const responseData: UserState = {
    uid: user.id,
    name: user.name,
    avatar: pendingAvatar ?? user.avatar,
    bio: pendingBio ?? user.bio,
    moemoepoint: user.moemoepoint,
    role: user.role,
    dailyCheckIn: user.daily_check_in,
    dailyImageLimit: user.daily_image_count,
    dailyUploadLimit: user.daily_upload_size,
    enableEmailNotice: user.enable_email_notice,
    allowPrivateMessage: user.allow_private_message,
    blockedTagIds: user.blocked_tag_ids,
    ...redirectConfig
  }

  return responseData
}
