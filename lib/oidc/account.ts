import { prisma } from '~/prisma/index'
import { rejectOnStampMismatch } from '~/server/auth/securityStamp'
import type { AccountClaims, FindAccount } from 'oidc-provider'

// 令牌最初的签发时刻 (秒)。refresh token 轮换时继承 iiat, 其余令牌只有 iat
const issuedAtOf = (token: { iat?: number } & { iiat?: number }) =>
  token.iiat ?? token.iat

// 把本站 user（Int 主键）映射为 OIDC account，sub 用字符串化的用户 id。
// 上游在换令牌 (授权码、refresh token) 与 userinfo 时把正在使用的令牌作为第三个参数传进来:
// 它签发得比安全戳早 (改密、重置之后), 就不再给出身份。OIDC 令牌带不了自定义版本,
// 只能按时间比; 与变更同一秒签发的会被放过
export const findAccount: FindAccount = async (_ctx, id, token) => {
  const uid = Number(id)
  if (!Number.isInteger(uid)) {
    return undefined
  }

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: {
      id: true,
      name: true,
      email: true,
      avatar: true,
      bio: true,
      status: true,
      security_stamp: true
    }
  })
  // status === 2 为封禁用户，与登录/JWT 校验一致，拒绝签发任何 OIDC 身份。
  if (!user || user.status === 2) {
    return undefined
  }
  const issuedAt = token ? issuedAtOf(token) : undefined
  if (
    user.security_stamp &&
    typeof issuedAt === 'number' &&
    issuedAt < Math.floor(user.security_stamp.getTime() / 1000) &&
    rejectOnStampMismatch('oidc', {
      uid,
      kind: token?.kind,
      issuedAt,
      userStamp: user.security_stamp.getTime()
    })
  ) {
    return undefined
  }

  return {
    accountId: id,
    async claims(_use, scope) {
      const scopes = new Set(scope.split(' '))
      const result: AccountClaims = { sub: id }
      if (scopes.has('profile')) {
        result.name = user.name
        result.picture = user.avatar || undefined
        result.profile = user.bio || undefined
      }
      if (scopes.has('email')) {
        result.email = user.email
        result.email_verified = true
      }
      return result
    }
  }
}
