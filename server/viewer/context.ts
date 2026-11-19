import 'server-only'
import { parseCookies } from '~/utils/cookies'
import { verifyKunTokenWithUser } from '~/server/auth/session'
import { shouldBypassSharedCache } from '~/app/api/utils/contentVisibility'
import {
  PUBLIC_VISIBILITY,
  toPublicListView,
  type ListView,
  type PatchVisibility,
  type PublicListView
} from './patchVisibility'

const KUN_AUTH_TOKEN_COOKIE = 'kun-galgame-patch-moe-token'
// 设置 store (zustand persist) 写出的分级设置 cookie。服务端只在本文件读它 (kun/inv-viewer-02 执法)。
// 旧版本的客户端还把屏蔽标签写成同前缀的 cookie, 残留的那份服务端不读: 屏蔽列表只取鉴权结果
const KUN_NSFW_SETTING_COOKIE =
  'kun-patch-setting-store|state|data|kunNsfwEnable'

type VerifiedSession = NonNullable<
  Awaited<ReturnType<typeof verifyKunTokenWithUser>>
>

export type ViewerSession =
  | ({ readonly kind: 'authenticated' } & VerifiedSession)
  | { readonly kind: 'anonymous' }

const ANONYMOUS_SESSION: ViewerSession = Object.freeze({ kind: 'anonymous' })

// 一个请求的视角: 是谁、能看到哪些作品、列表响应能不能进共享缓存。
// Route Handler 经 fromRequest、页面经 fromHeaders 各建一个, 建好后往下传;
// 同一个上下文里会话至多校验一次 (校验带 Redis 读写, 见 verifyKunTokenPayload)
export const createViewerContext = (cookieHeader: string) => {
  // 服务端读这两个 cookie 只在这里解码, 与 proxy 用同一个 parseCookies。畸形转义回落原值:
  // 回落后的 token 校验不过, 回落后的分级设置不在枚举里
  const cookies = parseCookies(cookieHeader)
  const token = cookies[KUN_AUTH_TOKEN_COOKIE]

  let pendingSession: Promise<ViewerSession> | undefined
  const loadSession = async (): Promise<ViewerSession> => {
    // 没有 token 就不碰 Redis
    if (!token) {
      return ANONYMOUS_SESSION
    }
    const verified = await verifyKunTokenWithUser(token)
    return verified ? { kind: 'authenticated', ...verified } : ANONYMOUS_SESSION
  }
  const session = () => (pendingSession ??= loadSession())

  const viewer = async () => {
    const current = await session()
    return current.kind === 'authenticated' ? current.payload : null
  }

  const visibility = async (): Promise<PatchVisibility> => {
    // 分级设置 cookie 没有签名, 只对有效会话采信; 否则任何人都能凭自己写的 cookie 拿到 NSFW 列表
    const current = await session()
    if (current.kind !== 'authenticated') {
      return PUBLIC_VISIBILITY
    }

    const nsfwSetting = cookies[KUN_NSFW_SETTING_COOKIE]
    return {
      contentLimit:
        nsfwSetting === 'all' ? null : nsfwSetting === 'nsfw' ? 'nsfw' : 'sfw',
      // 屏蔽列表只取鉴权结果 (库或鉴权缓存, 改屏蔽时由 invalidateUserSession 失效),
      // 不接受客户端带来的副本: 鉴权本来就把它加载出来了, 副本只会更旧
      blockedTagIds: current.user.blocked_tag_ids
    }
  }

  // 不带参数: 只会是 shared 或 filtered, 给不含待审核内容的列表 (作品列表) 用。
  // personalizedByPendingResource: 列表里有资源, 能看到待审核资源的用户拿到 personal
  function listView(): Promise<PublicListView>
  function listView(opts: {
    personalizedByPendingResource: true
  }): Promise<ListView>
  async function listView(opts?: {
    personalizedByPendingResource: true
  }): Promise<ListView> {
    const [current, payload] = await Promise.all([visibility(), viewer()])
    if (
      opts?.personalizedByPendingResource &&
      payload &&
      (await shouldBypassSharedCache(payload))
    ) {
      return { kind: 'personal', visibility: current, viewer: payload }
    }
    return toPublicListView(current)
  }

  return { session, viewer, visibility, listView }
}

export type ViewerContext = ReturnType<typeof createViewerContext>
