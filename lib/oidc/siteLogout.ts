import 'server-only'
import { createViewerContext } from '~/server/viewer/context'
import { deleteKunTokenSession } from '~/app/api/utils/jwt'
import { kunCookieOptions } from '~/app/api/utils/cookieOptions'
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
    // destroy 只删存储里的记录, 内存里的会话对象仍带着登出前的账号
    const accountId = oidc.session?.accountId
    if (!accountId) {
      return
    }
    const viewer = await createViewerContext(ctx.get('cookie'))
      .viewer()
      .catch(() => null)
    if (!viewer || String(viewer.uid) !== accountId) {
      return
    }

    // provider 会话已经销毁, 这里失败也照样清 cookie: 浏览器这一侧总能退出
    await deleteKunTokenSession(viewer.uid, viewer.jti).catch((error) => {
      // eslint-disable-next-line no-console
      console.error('Failed to revoke the site session on OIDC logout', error)
    })
    clearSiteCookie(ctx as KoaContextWithOIDC)
  })
}
