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
  const sameUsernameUser = await prisma.user.findFirst({
    where: { name: insensitiveEquals(username) }
  })
  if (sameUsernameUser) {
    return '您的用户名已经有人注册了, 请修改'
  }

  try {
    // 条件更新即 CAS: 余额守卫必须落在 WHERE 里, 否则读后写并发改名能把余额扣成负数.
    // Prisma 为此发出平铺 WHERE 的单条 UPDATE, READ COMMITTED 下后到者在行锁上等待,
    // 拿锁后重新求值 moemoepoint >= 30, 看到已被扣光便不匹配 -> count=0.
    // 改名与扣费在同一条语句里, 撞唯一索引时整条回滚, 不会白扣分.
    // 升级 Prisma 后须复验 SQL 形状: 若改发 WHERE id IN (SELECT ...) 子查询形式,
    // 重新求值不覆盖子查询 (它是另一个 RTE, 仍用语句起始快照), 守卫会静默失效
    const { count } = await prisma.user.updateMany({
      where: { id: uid, moemoepoint: { gte: 30 } },
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

  const res = await updateUsername(input.username, payload.uid)
  if (typeof res === 'string') {
    return NextResponse.json(res)
  }

  return NextResponse.json({})
}
