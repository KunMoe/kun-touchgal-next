import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminUpdateRedirectSchema } from '~/validations/admin'
import { ADMIN_REDIRECT_CONFIG_CACHE_DURATION } from '~/config/cache'
import { setKv } from '~/lib/redis'
import { prisma } from '~/prisma/index'
import {
  ADMIN_REDIRECT_REDIS_KEY,
  ADMIN_REDIRECT_SETTING_KEY,
  getRedirectConfig
} from './getRedirectConfig'
import { invalidateAllUserSessions } from '~/app/api/user/session/cache'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  handler: () => getRedirectConfig()
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminUpdateRedirectSchema,
  handler: async ({ input }) => {
    // 事实源写穿 admin_setting 表, Redis 仅作缓存 (volatile-lfu 下带 TTL 的键会被驱逐)
    await prisma.admin_setting.upsert({
      where: { key: ADMIN_REDIRECT_SETTING_KEY },
      create: { key: ADMIN_REDIRECT_SETTING_KEY, value: input },
      update: { value: input }
    })
    await setKv(
      ADMIN_REDIRECT_REDIS_KEY,
      JSON.stringify(input),
      ADMIN_REDIRECT_CONFIG_CACHE_DURATION
    )
    await invalidateAllUserSessions()
    return {}
  }
})
