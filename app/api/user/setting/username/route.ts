import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { prisma } from '~/prisma/index'
import { insensitiveEquals } from '~/app/api/utils/insensitiveEquals'
import { Prisma } from '~/prisma/generated/prisma/client'
import { usernameServerSchema } from '~/validations/reserved-username.server'
import { invalidateUserSession } from '~/app/api/user/session/cache'

// verifyHeaderCookie 已在 verifyAndLoadUser 里拦掉不存在/封禁的用户, 故此处不再
// 重复查一次用户; 用户不存在时 updateMany 自然 count=0, 不会扣分也不会改名
const updateUsername = async (username: string, uid: number) => {
  // 这条 ILIKE 只用来拦他人抢注的大小写变体, 必须排除调用者自己那一行: 不排除时
  // Kun -> KUN 这类改自己名字大小写的请求会命中本人, 恒报「已经有人注册」
  const sameUsernameUser = await prisma.user.findFirst({
    where: { name: insensitiveEquals(username), id: { not: uid } },
    select: { id: true }
  })
  if (sameUsernameUser) {
    return '您的用户名已经有人注册了, 请修改'
  }

  try {
    // 条件更新即 CAS: 余额守卫必须落在 WHERE 里, 否则读后写并发改名能把余额扣成负数.
    // Prisma 为此发出平铺 WHERE 的单条 UPDATE, READ COMMITTED 下后到者在行锁上等待,
    // 拿锁后重新求值 moemoepoint >= 30, 看到已被扣光便不匹配 -> count=0.
    // 改名与扣费在同一条语句里, 撞唯一索引时整条回滚, 不会白扣分.
    // name 守卫同理必须落在 WHERE 里: POST 里那道 payload.name 比对读的是鉴权缓存,
    // 改名落库后 invalidateUserSession 抛错时它会陈旧, 用户重试同一个新名就会被
    // 重复扣分 (并发双提交同理). 这里重新求值 name <> $2 是资金侧兜底, 代价是这种
    // 竞态下 count=0 会误报余额不足 —— 此时用户确实已被扣过一次, 文案偏差可接受.
    // 升级 Prisma 后须复验 SQL 形状: 若改发 WHERE id IN (SELECT ...) 子查询形式,
    // 重新求值不覆盖子查询 (它是另一个 RTE, 仍用语句起始快照), 守卫会静默失效
    const { count } = await prisma.user.updateMany({
      where: { id: uid, moemoepoint: { gte: 30 }, name: { not: username } },
      data: { name: username, moemoepoint: { increment: -30 } }
    })
    if (!count) {
      return '更改用户名最少需要 30 萌萌点, 您的萌萌点不足'
    }
  } catch (error) {
    // name 唯一索引兜底并发改名: 上面的查重与写入之间有窗口. 但索引是大小写敏感的
    // btree(name), 只兜底完全同名; 预检那条 ILIKE 想防的大小写变体 (Kun / kun 并发)
    // 不触发唯一索引, 要闭合须给生产库补 lower(name) 函数唯一索引
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

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, usernameServerSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  // payload.name 来自 verifyAndLoadUser 里的库 / 鉴权缓存, 不是 JWT 里的陈旧字段.
  // 必须拦在扣费之前: 预检排除自身后, 名字没变的提交会正常走完 updateMany, 白扣
  // 30 萌萌点 —— 原先是靠预检误命中自己把它挡下的
  if (input.username === payload.name) {
    return NextResponse.json('新用户名与当前用户名相同')
  }

  const res = await updateUsername(input.username, payload.uid)
  if (typeof res === 'string') {
    return NextResponse.json(res)
  }

  return NextResponse.json({})
}
