import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { randomNormalInt } from '~/utils/random'
import { invalidateUserSession } from '~/app/api/user/session/cache'

// verifyHeaderCookie 已在 verifyAndLoadUser 里拦掉不存在/封禁的用户, 故此处不再
// 重复查一次用户; 用户不存在时 updateMany 自然 count=0, 不会加分
const checkIn = async (uid: number) => {
  const randomMoemoepoints = randomNormalInt(2, 7)

  // 条件更新即 CAS: 签到状态只收敛在 daily_check_in 一列, 故无需通告锁或重试.
  // Prisma 为此发出平铺 WHERE 的单条 UPDATE, READ COMMITTED 下后到者在行锁上等待,
  // 拿锁后重新求值 WHERE, 看到已被翻成 1 便不匹配 -> count=0, 只有一条能加分.
  // 这靠的是编译出来的 SQL 形状: 若改发 WHERE id IN (SELECT ...) 子查询形式, 重新求值
  // 不覆盖子查询 (它是另一个 RTE, 仍用语句起始快照), 守卫会静默失效。形状由
  // __tests__/route.sql.test.ts 守护 (不连库, 升级 Prisma 时随 pnpm test 复验),
  // 库的重新求值由 __tests__/route.db.test.ts 在真库上守护
  const { count } = await prisma.user.updateMany({
    where: { id: uid, daily_check_in: 0 },
    data: {
      moemoepoint: { increment: randomMoemoepoints },
      daily_check_in: { set: 1 }
    }
  })
  if (!count) {
    return '您今天已经签到过了'
  }

  await invalidateUserSession(uid)

  return { randomMoemoepoints }
}

export const POST = kunRoute.post({
  auth: 'user',
  handler: async ({ actor: payload }) => checkIn(payload.uid)
})
