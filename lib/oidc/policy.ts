import 'server-only'
import { interactionPolicy } from 'oidc-provider'
import { createViewerContext } from '~/server/viewer/context'
import type { KoaContextWithOIDC } from 'oidc-provider'

const { Check } = interactionPolicy

export const SITE_SESSION_CHECK_REASON = 'site_session_mismatch'

// 授权端点要不要弹交互只在这里判定 (provider 的交互策略), 而上游默认的 login 检查只看
// provider 自己的 Session (14 天, 滑动续期)。站点这边的登出、改密、封禁、删号都只动站点会话,
// 所以「此刻谁已认证」以站点会话为准: 两边不是同一个账号就要求登录交互,
// 交互页再按站点 cookie 走 confirm (换号时上游会先登出旧的 provider 会话)。
// 判定读的是请求带来的站点 cookie, 对部署之前就存在的 provider 会话同样生效
export const checkSiteSession = async (
  ctx: KoaContextWithOIDC
): Promise<boolean> => {
  const { session, account, result } = ctx.oidc
  const accountId = session?.accountId
  // 没有 provider 会话: 交给上游的 no_session
  if (!accountId) {
    return Check.NO_NEED_TO_PROMPT
  }
  // 有会话却载不到账号 (封禁或删号, findAccount 返回 undefined): 必须拦在 login 这一层,
  // 放过去的话 consent 的检查会去读不存在的 grant 而抛 TypeError, 浏览器每次授权都是 500
  if (!account) {
    return Check.REQUEST_PROMPT
  }
  // 刚完成的 login 交互回到授权端点: 账号就是 confirm 按站点 cookie 写进来的那个
  if (result?.login) {
    return Check.NO_NEED_TO_PROMPT
  }
  // 站点会话解析失败 (Redis 或库不可用) 也按未登录处理: 宁可多一次交互, 不凭旧会话放行
  const viewer = await createViewerContext(ctx.get('cookie'))
    .viewer()
    .catch(() => null)
  return viewer && String(viewer.uid) === accountId
    ? Check.NO_NEED_TO_PROMPT
    : Check.REQUEST_PROMPT
}

// 在上游默认策略的 login prompt 末尾追加站点会话检查。错误码必须显式给:
// 构造之后才加进去的 Check 拿不到 prompt 的默认错误码, prompt=none 会收到 interaction_required
export const buildKunInteractionPolicy = () => {
  const policy = interactionPolicy.base()
  const login = policy.get('login')
  if (!login) {
    throw new Error('oidc-provider 的默认交互策略里没有 login prompt')
  }
  login.checks.add(
    new Check(
      SITE_SESSION_CHECK_REASON,
      '站点登录态缺失或与 SSO 会话不一致',
      'login_required',
      checkSiteSession
    )
  )
  return policy
}
