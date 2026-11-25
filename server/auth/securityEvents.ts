import { cookies } from 'next/headers'
import {
  deleteKunToken,
  deleteOtherKunTokenSessions,
  reissueKunSessionToken
} from './session'
import { invalidateUserSession } from './sessionCache'
import type { Prisma, PrismaClient } from '~/prisma/generated/prisma/client'
import type { KunGalgamePayload } from './session'

// 账号安全事件与它们的吊销策略。「哪个事件吊销什么」只写在 KUN_SECURITY_POLICY 这一张表里:
//   bumpStamp: 与凭据写在同一条语句里刷新安全戳。站点上别的会话与 OIDC 令牌因此在结构上失效,
//              不依赖提交之后的删键有没有跑完 (在途登录、2FA 第二步的窗口也拦得住)
//   current:   发起这次变更的会话: revoke 登出 (清 cookie), keep 保留 (刷新了戳就重签),
//              none 没有当前会话 (邮件链接、管理员代为操作、脚本)
//   redis:     提交之后删哪些会话键 (all 全部 / others 除当前之外 / none), 是卫生清理, 也让
//              会话列表立刻反映出来
// 用法: 写凭据经 applyKunCredentialChange (可以在事务里), 提交之后调 finishKunSecurityEvent
export type KunSecurityEvent =
  | 'password-changed'
  | 'password-reset'
  | 'password-rehashed'
  | 'email-changed'
  | 'email-reverted'
  | '2fa-secret-staged'
  | '2fa-enabled'
  | '2fa-disabled'
  | '2fa-disabled-by-admin'
  | 'admin-edited'
  | 'admin-credentials-changed'
  | 'creator-approved'
  | 'username-reserved-migrated'
  | 'other-sessions-revoked'
  | 'account-deletion-started'
  | 'account-deleted'
  | 'ban-detected'

interface KunSecurityPolicy {
  bumpStamp: boolean
  current: 'revoke' | 'keep' | 'none'
  redis: 'all' | 'others' | 'none'
}

export const KUN_SECURITY_POLICY = {
  'password-changed': { bumpStamp: true, current: 'revoke', redis: 'all' },
  'password-reset': { bumpStamp: true, current: 'none', redis: 'all' },
  // 登录时把旧格式的哈希换成新格式: 密码没变, 不动任何会话
  'password-rehashed': { bumpStamp: false, current: 'none', redis: 'none' },
  // 改邮箱、启用 / 关闭 2FA: 其它设备全部登出, 发起变更的这台保留 (重签)
  'email-changed': { bumpStamp: true, current: 'keep', redis: 'others' },
  // 撤销邮箱变更 (邮件链接, 没有当前会话): 改走邮箱的人手里多半还握着一个会话, 全部登出,
  // 刷新戳让已签发给依赖方的 OIDC 令牌一并作废
  'email-reverted': { bumpStamp: true, current: 'none', redis: 'all' },
  // 只生成待确认的密钥: 2FA 还没生效, 不动会话
  '2fa-secret-staged': { bumpStamp: false, current: 'none', redis: 'none' },
  '2fa-enabled': { bumpStamp: true, current: 'keep', redis: 'others' },
  '2fa-disabled': { bumpStamp: true, current: 'keep', redis: 'others' },
  '2fa-disabled-by-admin': { bumpStamp: false, current: 'none', redis: 'all' },
  // 改权 (降权 / 封禁) 必须删光会话: 鉴权缓存只在命中 Redis 会话之后才读, 删掉会话是「旧权限
  // 缓存不被采信」的根闸门 (只轮转缓存版本键会被吞掉失败)
  'admin-edited': { bumpStamp: false, current: 'none', redis: 'all' },
  // 后台替人改了密码或邮箱 (账号恢复): 与本人改密一样刷新戳, 已签发给依赖方的 OIDC 令牌一并作废
  'admin-credentials-changed': {
    bumpStamp: true,
    current: 'none',
    redis: 'all'
  },
  // 只把普通用户提为创作者: 升权, 鉴权缓存失效即可, 不登出
  'creator-approved': { bumpStamp: false, current: 'none', redis: 'none' },
  'username-reserved-migrated': {
    bumpStamp: false,
    current: 'none',
    redis: 'all'
  },
  // 「退出其它设备」: 刷新戳让被退出的设备手里的 OIDC 令牌也作废
  'other-sessions-revoked': {
    bumpStamp: true,
    current: 'keep',
    redis: 'others'
  },
  // 删号的第一步是封禁 (server/account/deleteAccount.ts): 与后台封禁一样删光会话, 之后分批清除
  // 内容的期间, 该账号的请求都被 status 闸门拒绝
  'account-deletion-started': {
    bumpStamp: false,
    current: 'none',
    redis: 'all'
  },
  'account-deleted': { bumpStamp: false, current: 'none', redis: 'all' },
  // 解析会话时发现账号已不存在或已封禁 (库给出的正面证据)
  'ban-detected': { bumpStamp: false, current: 'none', redis: 'all' }
} as const satisfies Record<KunSecurityEvent, KunSecurityPolicy>

type KunUserWriter = Pick<PrismaClient | Prisma.TransactionClient, 'user'>

// 写凭据或安全属性的唯一入口 (server/auth 之外对这几列的字面量写入由 lint 拦住)。
// 平铺 WHERE 的 updateMany: 调用方的前置条件 (旧邮箱、旧哈希、2FA 状态) 放在 where 里,
// 并发下由数据库重新判定, 命中 0 行就是没写成。策略要求时安全戳写在同一个 data 里。
// 保留并重签当前会话的事件 (current: keep 且刷新戳) 还要以当前令牌带的戳为条件 (currentStamp,
// 即 tokenStampOf(payload)): 这个请求通过鉴权之后戳若已被别处刷新 (重置密码、另一台设备
// 退出其它设备), 它的会话本该失效, 命中 0 行, 不能接着删别人的会话再把自己重签回来
export const applyKunCredentialChange = async (
  db: KunUserWriter,
  {
    uid,
    event,
    data,
    where = {},
    currentStamp
  }: {
    uid: number
    event: KunSecurityEvent
    // 萌萌点只由 server/points 写 (kun/inv-points-01): 写入体里带着它 (含经展开带进来的) 编译不过
    data: Prisma.userUpdateManyMutationInput & { moemoepoint?: never }
    where?: Prisma.userWhereInput
    currentStamp?: number
  }
): Promise<{ count: number; stamp: Date | null }> => {
  const policy: KunSecurityPolicy = KUN_SECURITY_POLICY[event]
  const keepsCurrent = policy.current === 'keep' && policy.bumpStamp
  if (keepsCurrent && currentStamp === undefined) {
    throw new Error(`安全事件 ${event} 需要传入当前令牌的安全戳`)
  }
  const stamp = policy.bumpStamp ? new Date() : null
  const { count } = await db.user.updateMany({
    where: {
      ...where,
      ...(keepsCurrent
        ? { security_stamp: currentStamp ? new Date(currentStamp) : null }
        : {}),
      id: uid
    },
    data: stamp ? { ...data, security_stamp: stamp } : data
  })
  return { count, stamp: count ? stamp : null }
}

const KUN_AUTH_TOKEN_COOKIE = 'kun-galgame-patch-moe-token'

// 提交之后的收尾: 失效会话缓存, 按策略删会话键, 处理当前会话。current 是发起这次变更的会话
// (路由里 verifyHeaderCookie 拿到的 payload), stamp 是 applyKunCredentialChange 刚写下的戳
export const finishKunSecurityEvent = async (
  uid: number,
  event: KunSecurityEvent,
  options: { current?: KunGalgamePayload; stamp?: Date | null } = {}
): Promise<{ revokedOthers: number }> => {
  const policy: KunSecurityPolicy = KUN_SECURITY_POLICY[event]
  const { current, stamp } = options
  if ((policy.redis === 'others' || policy.current !== 'none') && !current) {
    throw new Error(`安全事件 ${event} 需要传入当前会话`)
  }

  await invalidateUserSession(uid)

  let revokedOthers = 0
  if (policy.redis === 'all') {
    await deleteKunToken(uid)
  } else if (policy.redis === 'others' && current) {
    revokedOthers = await deleteOtherKunTokenSessions(uid, current.jti)
  }

  if (policy.current === 'revoke') {
    const cookie = await cookies()
    cookie.delete(KUN_AUTH_TOKEN_COOKIE)
  } else if (policy.current === 'keep' && policy.bumpStamp && current) {
    // 戳已经变了, 当前会话手里的令牌带的是旧戳: 重签一张带新戳的 (同一个会话、同一个认证时刻)
    if (!stamp) {
      throw new Error(`安全事件 ${event} 刷新了安全戳, 重签需要传入新戳`)
    }
    await reissueKunSessionToken(current, stamp)
  }

  return { revokedOthers }
}
