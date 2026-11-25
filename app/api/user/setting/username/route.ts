import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { isUsernameTaken } from '~/server/identity/lookup'
import { Prisma } from '~/prisma/generated/prisma/client'
import { usernameServerSchema } from '~/validations/reserved-username.server'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { spendOnRename } from '~/server/points/account'
import { POINT_GATE_MESSAGE } from '~/constants/points'

// verifyHeaderCookie 已在 verifyAndLoadUser 里拦掉不存在/封禁的用户, 故此处不再
// 重复查一次用户; 用户不存在时 spendOnRename 返回 false, 不会扣分也不会改名
const updateUsername = async (username: string, uid: number) => {
  // 排除调用者自己那一行: 不排除时 Kun -> KUN 这类改自己名字大小写的请求会命中本人,
  // 恒报「已经有人注册」
  if (await isUsernameTaken(username, { exceptUid: uid })) {
    return '您的用户名已经有人注册了, 请修改'
  }

  try {
    // 余额守卫与 name 守卫都在同一条 UPDATE 的 WHERE 里, 改名与扣费撞唯一索引时整条回滚,
    // 不会白扣分。POST 里那道 payload.name 比对读的是鉴权缓存, 改名落库后
    // invalidateUserSession 抛错时它会陈旧, 重试同一个新名由 name 守卫挡住重复扣分 (误报
    // 余额不足, 此时用户确实已被扣过一次)。形状由 __tests__/route.sql.test.ts 守护
    // (不连库, 升级 Prisma 时随 pnpm test 复验)
    if (!(await spendOnRename(prisma, uid, username))) {
      return POINT_GATE_MESSAGE.rename
    }
  } catch (error) {
    // 唯一索引兜底并发改名: 上面的查重与写入之间有窗口, 完全同名撞 name 的 @unique,
    // 只差大小写 (Kun / kun 并发) 撞迁移 0018 的 lower(name) 索引, 都是 P2002
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return '您的用户名已经有人注册了, 请修改'
    }
    throw error
  }

  await invalidateUserSession(uid)
}

export const POST = kunRoute.post({
  auth: 'user',
  input: usernameServerSchema,
  handler: async ({ input, actor: payload }) => {
    // payload.name 来自 verifyAndLoadUser 里的库 / 鉴权缓存, 不是 JWT 里的陈旧字段.
    // 必须拦在扣费之前: 预检排除自身后, 名字没变的提交本会正常走完扣费 (现在由
    // spendOnRename 的 name 守卫兜底) —— 原先是靠预检误命中自己把它挡下的
    if (input.username === payload.name) {
      return '新用户名与当前用户名相同'
    }

    const res = await updateUsername(input.username, payload.uid)
    if (typeof res === 'string') {
      return res
    }

    return {}
  }
})
