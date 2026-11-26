import 'server-only'
import { parseCookies } from '~/utils/cookies'
import {
  decodeKunSessionToken,
  deleteKunTokenSession
} from '~/server/auth/session'
import { kunCookieOptions } from '~/server/auth/cookieOptions'
import { kunLog } from '~/lib/log.server'
import type Provider from 'oidc-provider'
import type { KoaContextWithOIDC } from 'oidc-provider'

const KUN_AUTH_TOKEN_COOKIE = 'kun-galgame-patch-moe-token'

// 与站点登录时写 cookie 的属性一致 (kunCookieOptions, 默认 Path=/), 浏览器才认作同一个 cookie
const clearSiteCookie = (ctx: KoaContextWithOIDC) => {
  const { secure } = kunCookieOptions(0)
  ctx.append(
    'Set-Cookie',
    `${KUN_AUTH_TOKEN_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  )
}

// 依赖方发起的登出: 用户在登出确认页点「是」(end_session_confirm 带 logout) 后,
// 上游只销毁 provider 自己的会话; 站点会话也要跟着退出, 否则下一次授权凭站点 cookie
// 零交互恢复同一个账号。只在 provider 会话与站点 cookie 是同一个账号时才退:
// 换号时上游也会自动提交这张表单 (登出旧账号的 provider 会话), 那时站点 cookie 已是新账号。
// 不订阅 end_session.success: 换号路径同样会触发它, 而且监听器不被 await
export const registerKunSiteLogout = (provider: Provider) => {
  provider.use(async (ctx, next) => {
    await next()

    const { oidc } = ctx as KoaContextWithOIDC
    if (oidc?.route !== 'end_session_confirm' || !oidc.params?.logout) {
      return
    }
    // 上游的错误处理在路由栈内部, 确认失败 (xsrf 不对、会话已过期) 时这里照样会跑:
    // 只认 provider 会话确实被销毁了。destroy 只删存储里的记录, 内存里的会话对象仍带着登出前的账号
    // destroyed 是上游 Session.destroy() 置上的标记 (models/session.js), 类型声明里没有
    const session = oidc.session as
      (NonNullable<typeof oidc.session> & { destroyed?: boolean }) | undefined
    if (!session?.destroyed || !session.accountId) {
      return
    }
    // 只验 cookie 的签名, 不经 Redis 解析会话: Redis 此刻不可用时也要清掉 cookie,
    // 否则恢复之后下一次授权凭它零交互登回同一个账号
    const token = parseCookies(ctx.get('cookie'))[KUN_AUTH_TOKEN_COOKIE]
    const site = token ? decodeKunSessionToken(token) : null
    if (!site || String(site.uid) !== session.accountId) {
      return
    }

    // provider 会话已经销毁, 这里失败也照样清 cookie: 浏览器这一侧总能退出
    await deleteKunTokenSession(site.uid, site.jti).catch((error) => {
      kunLog(
        'auth.session_revoke_failed',
        { reason: 'oidc_logout', uid: site.uid },
        error
      )
    })
    clearSiteCookie(ctx as KoaContextWithOIDC)
  })
}
