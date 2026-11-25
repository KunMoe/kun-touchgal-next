import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { claimCheckIn } from '~/server/points/account'

// verifyHeaderCookie 已在 verifyAndLoadUser 里拦掉不存在/封禁的用户, 故此处不再
// 重复查一次用户; 用户不存在时与已签到一样不会加分
const checkIn = async (uid: number) => {
  // 条件更新即 CAS, 后到者拿锁后看到 daily_check_in 已被翻成 1, 只有一条能加分。形状由
  // __tests__/route.sql.test.ts 守护 (不连库, 升级 Prisma 时随 pnpm test 复验), 库的
  // 重新求值由 __tests__/route.db.test.ts 在真库上守护
  const { claimed, amount: randomMoemoepoints } = await claimCheckIn(
    prisma,
    uid
  )
  if (!claimed) {
    return '您今天已经签到过了'
  }

  await invalidateUserSession(uid)

  return { randomMoemoepoints }
}

export const POST = kunRoute.post({
  auth: 'user',
  handler: async ({ actor: payload }) => checkIn(payload.uid)
})
