import 'server-only'
import { parseCookies } from '~/utils/cookies'
import { parseBlockedTagIds } from '~/utils/blockedTag'
import { verifyKunTokenWithUser } from '~/app/api/utils/jwt'
import { shouldBypassSharedCache } from '~/app/api/utils/contentVisibility'
import {
  PUBLIC_VISIBILITY,
  toPublicListView,
  type ListView,
  type PatchVisibility,
  type PublicListView
} from './patchVisibility'

const KUN_AUTH_TOKEN_COOKIE = 'kun-galgame-patch-moe-token'
// 设置 store (zustand persist) 写出的两个镜像 cookie: 分级设置, 用户屏蔽的标签 id。
// 服务端只在本文件读它们 (kun/inv-viewer-02 执法)
const KUN_NSFW_SETTING_COOKIE =
  'kun-patch-setting-store|state|data|kunNsfwEnable'
const KUN_BLOCKED_TAG_MIRROR_COOKIE =
  'kun-patch-setting-store|state|data|kunBlockedTagIds'

type VerifiedSession = NonNullable<
  Awaited<ReturnType<typeof verifyKunTokenWithUser>>
>

export type ViewerSession =
  | ({ readonly kind: 'authenticated' } & VerifiedSession)
  | { readonly kind: 'anonymous' }

const ANONYMOUS_SESSION: ViewerSession = { kind: 'anonymous' }

// 一个请求的视角: 是谁、能看到哪些作品、列表响应能不能进共享缓存。
// Route Handler 经 fromRequest、页面经 fromHeaders 各建一个, 建好后往下传;
// 同一个上下文里会话至多校验一次 (校验带 Redis 读写, 见 verifyKunTokenPayload)
export const createViewerContext = (cookieHeader: string) => {
  // 服务端读这三个 cookie 只在这里解码, 与 proxy 用同一个 parseCookies:
  // 畸形转义回落原值, 回落后的 token 校验不过, 回落后的设置值不被采信
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
    // 两个设置 cookie 都没有签名, 只对有效会话采信; 否则任何人都能凭自己写的 cookie
    // 拿到 NSFW 列表, 或让屏蔽标签进入查询条件
    const current = await session()
    if (current.kind !== 'authenticated') {
      return PUBLIC_VISIBILITY
    }

    const nsfwSetting = cookies[KUN_NSFW_SETTING_COOKIE]
    // null 是镜像不可用 (没有这个 cookie、畸形转义、坏 JSON、不是数组), 以库里的为准;
    // [] 是合法的镜像 (用户清空了屏蔽列表), 不能当成不可用
    const mirrored = parseBlockedTagIds(cookies[KUN_BLOCKED_TAG_MIRROR_COOKIE])
    return {
      contentLimit:
        nsfwSetting === 'all' ? null : nsfwSetting === 'nsfw' ? 'nsfw' : 'sfw',
      blockedTagIds: mirrored ?? current.user.blocked_tag_ids
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
