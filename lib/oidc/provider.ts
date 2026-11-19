import Provider from 'oidc-provider'
import type { Configuration, JWKS } from 'oidc-provider'
import {
  OIDC_CLAIMS,
  OIDC_ISSUER,
  OIDC_MOUNT_PATH,
  OIDC_TTL
} from '~/config/oidc'
import { createOidcAdapter } from './adapter'
import { findAccount } from './account'
import { buildKunInteractionPolicy } from './policy'

type OidcCallback = ReturnType<Provider['callback']>

const globalForOidc = globalThis as unknown as {
  oidcProvider?: Provider
  oidcCallback?: OidcCallback
}

const getJwks = (): JWKS => {
  const raw = process.env.OIDC_JWKS
  if (!raw) {
    throw new Error(
      'OIDC_JWKS 未配置，请运行 pnpm exec esno scripts/generateOidcJwks.ts 生成'
    )
  }
  return JSON.parse(raw) as JWKS
}

const getCookieKeys = () => {
  const raw = process.env.OIDC_COOKIE_KEYS
  if (!raw) {
    throw new Error('OIDC_COOKIE_KEYS 未配置')
  }
  return raw
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
}

const createProvider = () => {
  const configuration: Configuration = {
    adapter: createOidcAdapter,
    jwks: getJwks(),
    claims: OIDC_CLAIMS,
    ttl: OIDC_TTL,
    findAccount,
    // 透传自定义 client 元数据，使 adapter 返回的 is_first_party 保留到 client 实例。
    extraClientMetadata: {
      properties: ['is_first_party']
    },
    // 仅放行 client 已注册 redirect_uri 所在源的跨域请求，而非任意源。
    clientBasedCORS: (_ctx, origin, client) =>
      (client.redirectUris ?? []).some((uri) => {
        try {
          return new URL(uri).origin === origin
        } catch {
          return false
        }
      }),
    cookies: {
      keys: getCookieKeys(),
      names: { session: '_touchgal_oidc_session' }
    },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: true },
      userinfo: { enabled: true }
    },
    interactions: {
      policy: buildKunInteractionPolicy(),
      url(_ctx, interaction) {
        return `${OIDC_MOUNT_PATH}/interaction/${interaction.uid}`
      }
    },
    // 可信一方应用登录后免同意：无既有 grant 时直接为请求的 scope 建授权并返回，
    // provider 便跳过 consent 交互；第三方 client 仍走 ConsentCard。
    // 限制：offline_access 被 oidc-provider 强制要求经 consent prompt 才保留，故本路径不覆盖
    // 需要 refresh token 的场景——请求 offline_access 的一方应用仍会显示同意屏。
    async loadExistingGrant(ctx) {
      const { client, session } = ctx.oidc
      if (!client || !session) {
        return undefined
      }
      const grantId =
        ctx.oidc.result?.consent?.grantId ?? session.grantIdFor(client.clientId)
      if (grantId) {
        return ctx.oidc.provider.Grant.find(grantId)
      }
      const isFirstParty = (client as { is_first_party?: boolean })
        .is_first_party
      if (!isFirstParty || !session.accountId) {
        return undefined
      }
      const grant = new ctx.oidc.provider.Grant({
        clientId: client.clientId,
        accountId: session.accountId
      })
      const scope = ctx.oidc.params?.scope
      if (typeof scope === 'string' && scope) {
        grant.addOIDCScope(scope)
      }
      await grant.save()
      return grant
    }
  }

  const provider = new Provider(OIDC_ISSUER, configuration)
  // 生产环境经反向代理，信任 x-forwarded-proto 以匹配 https issuer。
  if (process.env.NODE_ENV === 'production') {
    provider.proxy = true
  }
  return provider
}

// provider 实例化开销大，全局单例避免 dev HMR 重复创建（仿 prisma/index.ts）。
export const getOidcProvider = () => {
  if (!globalForOidc.oidcProvider) {
    globalForOidc.oidcProvider = createProvider()
  }
  return globalForOidc.oidcProvider
}

// callback() 每次调用都会重新组合 Koa 中间件，缓存一次复用（官方推荐用法）。
export const getOidcCallback = (): OidcCallback => {
  if (!globalForOidc.oidcCallback) {
    globalForOidc.oidcCallback = getOidcProvider().callback()
  }
  return globalForOidc.oidcCallback
}
