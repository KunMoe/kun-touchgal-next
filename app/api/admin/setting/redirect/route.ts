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
import { toWellFormedDeep } from '~/utils/text/unicode'

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
    // value 是 jsonb, 孤立代理会让整条写入被拒; 缓存与库存同一份
    const value = toWellFormedDeep(input)
    // 事实源写穿 admin_setting 表, Redis 仅作缓存 (volatile-lfu 下带 TTL 的键会被驱逐)
    await prisma.admin_setting.upsert({
      where: { key: ADMIN_REDIRECT_SETTING_KEY },
      create: { key: ADMIN_REDIRECT_SETTING_KEY, value },
      update: { value }
    })
    await setKv(
      ADMIN_REDIRECT_REDIS_KEY,
      JSON.stringify(value),
      ADMIN_REDIRECT_CONFIG_CACHE_DURATION
    )
    await invalidateAllUserSessions()
    return {}
  }
})
