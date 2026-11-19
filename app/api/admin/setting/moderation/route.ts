import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminUpdateModerationSettingSchema } from '~/validations/admin'
import { delKv, setKv } from '~/lib/redis'
import {
  KUN_MODERATION_DRY_RUN_KEY,
  KUN_MODERATION_ENABLED_KEY
} from '~/config/redis'
import { prisma } from '~/prisma/index'
import { clearModerationConfigCache } from '~/server/moderation/config'
import { getModerationSetting } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  handler: () => getModerationSetting()
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminUpdateModerationSettingSchema,
  handler: async ({ input, actor }) => {
    const admin = await prisma.user.findUnique({ where: { id: actor.uid } })
    if (!admin) {
      return '未找到该管理员'
    }

    const previous = await getModerationSetting()

    if (input.enabled) {
      await setKv(KUN_MODERATION_ENABLED_KEY, 'true')
    } else {
      await delKv(KUN_MODERATION_ENABLED_KEY)
    }
    if (input.dryRun) {
      await setKv(KUN_MODERATION_DRY_RUN_KEY, 'true')
    } else {
      await delKv(KUN_MODERATION_DRY_RUN_KEY)
    }
    clearModerationConfigCache()

    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: actor.uid,
        content: `管理员 ${admin.name} 更新了 AI 审核设置\n启用审核: ${previous.enabled} -> ${input.enabled}\n灰度模式: ${previous.dryRun} -> ${input.dryRun}`
      }
    })

    return {}
  }
})
