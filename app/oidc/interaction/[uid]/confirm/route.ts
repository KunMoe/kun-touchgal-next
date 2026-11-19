import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import type { KoaContextWithOIDC } from 'oidc-provider'
import { errors } from 'oidc-provider'
import { getOidcProvider } from '~/lib/oidc/provider'
import { findAccount } from '~/lib/oidc/account'
import { buildRequestBridge } from '~/lib/oidc/webToNode'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { OIDC_MOUNT_PATH } from '~/config/oidc'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PromptMissing {
  missingOIDCScope?: string[]
  missingOIDCClaims?: string[]
  missingResourceScopes?: Record<string, string[]>
}

type InteractionDetails = Awaited<
  ReturnType<ReturnType<typeof getOidcProvider>['interactionDetails']>
>

// 依赖方要求重新认证 (prompt=login, 或 max_age 已超出) 时, 站点 cookie 本身不算数:
// 只有这次交互开始之后才在站点登录过 (认证时刻不早于交互创建时刻) 才放行
const needsFreshLogin = (details: InteractionDetails, authTime: number) => {
  if (authTime >= details.iat) {
    return false
  }
  const { reasons, details: promptDetails } = details.prompt
  if (reasons.includes('login_prompt')) {
    return true
  }
  const maxAge = Number(promptDetails.max_age)
  return (
    reasons.includes('max_age') &&
    Number.isFinite(maxAge) &&
    Math.floor(Date.now() / 1000) - authTime > maxAge
  )
}

// 完成 login 交互：确认本站登录态后把 accountId 与站点的认证时刻写入 provider session。
export const GET = async (
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) => {
  const { uid } = await params
  const interactionPath = `${OIDC_MOUNT_PATH}/interaction/${uid}`
  const loginUrl = new URL(
    `/login?from=${encodeURIComponent(interactionPath)}`,
    req.url
  )
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.redirect(loginUrl)
  }

  const provider = getOidcProvider()
  const bridge = await buildRequestBridge(req, false, { skipBody: true })
  bridge.req.push(null)
  // 认证时刻是站点登录的时刻 (令牌的 auth_time; 之前签发的令牌没有它, 取 iat), 不是此刻:
  // 否则 id_token 的 auth_time 恒为确认时刻, max_age / prompt=login 的重新认证要求被一个旧 cookie 零交互满足
  const siteAuthTime = payload.auth_time ?? payload.iat
  const authTime = siteAuthTime ?? 0
  try {
    const details = await provider.interactionDetails(bridge.req, bridge.res)
    if (needsFreshLogin(details, authTime)) {
      // 去站点登录页重新输入凭据, 登录后回到交互页再走一次 confirm
      return NextResponse.redirect(loginUrl)
    }
    // 站点会话判为有效 (鉴权缓存还没过期), provider 却已认不出这个账号 (刚封禁或删号):
    // 照样写进 login 结果的话, 授权端点载不到账号又要求登录, 浏览器在两边之间来回跳转不停
    if (!(await findAccount({} as KoaContextWithOIDC, String(payload.uid)))) {
      await provider.interactionFinished(bridge.req, bridge.res, {
        error: 'access_denied',
        error_description: '该账号当前无法授权'
      })
      return bridge.toResponse()
    }
    await provider.interactionFinished(bridge.req, bridge.res, {
      login: { accountId: String(payload.uid), ts: siteAuthTime }
    })
  } catch (error) {
    // interaction 已被消费或过期（如后台 fetch 跑完 303 链后的重放）：
    // 回 interaction 页渲染「会话已失效」提示，而非 500。
    if (error instanceof errors.SessionNotFound) {
      return NextResponse.redirect(new URL(interactionPath, req.url), 303)
    }
    throw error
  }
  return bridge.toResponse()
}

// 完成 consent 交互：构造 Grant 授予请求的 scope/claims，或按取消返回 access_denied。
export const POST = async (
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) => {
  const { uid } = await params
  const provider = getOidcProvider()
  const denied = new URL(req.url).searchParams.get('error')

  const bridge = await buildRequestBridge(req, false, { skipBody: true })
  bridge.req.push(null)
  let details: Awaited<ReturnType<typeof provider.interactionDetails>>
  try {
    details = await provider.interactionDetails(bridge.req, bridge.res)
  } catch (error) {
    // 重复提交（如回退后再次点击同意）时 interaction 已不存在，同样回落友好提示。
    if (error instanceof errors.SessionNotFound) {
      return NextResponse.redirect(
        new URL(`${OIDC_MOUNT_PATH}/interaction/${uid}`, req.url),
        303
      )
    }
    throw error
  }

  if (denied) {
    await provider.interactionFinished(bridge.req, bridge.res, {
      error: 'access_denied',
      error_description: '用户取消了授权'
    })
    return bridge.toResponse()
  }

  const accountId = details.session?.accountId
  if (!accountId) {
    return NextResponse.json('授权会话缺少登录态', { status: 401 })
  }
  // 同意页停留期间站点可能已登出或换了账号: 建 Grant 之前再按站点会话复核一次,
  // 不一致就结束这次授权, 不替 SSO 会话里的旧账号授权
  const viewer = await verifyHeaderCookie(req)
  if (!viewer || String(viewer.uid) !== accountId) {
    await provider.interactionFinished(bridge.req, bridge.res, {
      error: 'login_required',
      error_description: '站点登录态已变化, 请重新登录'
    })
    return bridge.toResponse()
  }

  const missing = details.prompt.details as PromptMissing
  let grant = details.grantId
    ? await provider.Grant.find(details.grantId)
    : undefined
  if (!grant) {
    grant = new provider.Grant({
      accountId,
      clientId: String(details.params.client_id ?? '')
    })
  }
  if (missing.missingOIDCScope) {
    grant.addOIDCScope(missing.missingOIDCScope.join(' '))
  }
  if (missing.missingOIDCClaims) {
    grant.addOIDCClaims(missing.missingOIDCClaims)
  }
  if (missing.missingResourceScopes) {
    for (const [indicator, scopes] of Object.entries(
      missing.missingResourceScopes
    )) {
      grant.addResourceScope(indicator, scopes.join(' '))
    }
  }
  const grantId = await grant.save()

  await provider.interactionFinished(
    bridge.req,
    bridge.res,
    { consent: { grantId } },
    { mergeWithLastSubmission: true }
  )
  return bridge.toResponse()
}
