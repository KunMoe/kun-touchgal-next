import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { errors } from 'oidc-provider'
import { getOidcProvider } from '~/lib/oidc/provider'
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

// 完成 login 交互：确认本站登录态后把 accountId 写入 provider session。
export const GET = async (
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) => {
  const { uid } = await params
  const interactionPath = `${OIDC_MOUNT_PATH}/interaction/${uid}`
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.redirect(
      new URL(`/login?from=${encodeURIComponent(interactionPath)}`, req.url)
    )
  }

  const provider = getOidcProvider()
  const bridge = await buildRequestBridge(req, false, { skipBody: true })
  bridge.req.push(null)
  try {
    await provider.interactionFinished(bridge.req, bridge.res, {
      login: { accountId: String(payload.uid) }
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
