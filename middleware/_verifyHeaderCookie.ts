import { parseCookies } from '~/utils/cookies'
import { verifyKunTokenWithUser } from '~/app/api/utils/jwt'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import type { NextRequest } from 'next/server'

// 只要会话 payload 的入口沿用这个适配器; 同一个请求里还要视角 (可见性、列表缓存) 的入口
// 直接建一个 viewerContextFromRequest(req) 往下传, 不要两个都调 (会校验两次会话)
export const verifyHeaderCookie = (req: NextRequest) =>
  viewerContextFromRequest(req).viewer()

// 请求级 memo: 同一请求内多处需要鉴权时只跑一次 verifyAndLoadUser
// (verifyHeaderCookie / getBlockedTagIds / getNSFWHeader 共享同一次 user.findUnique)
export const createAuthLoader = (req: NextRequest) => {
  const token =
    parseCookies(req.headers.get('cookie') ?? '')[
      'kun-galgame-patch-moe-token'
    ] ?? ''
  let cached: ReturnType<typeof verifyKunTokenWithUser> | undefined
  return () => (cached ??= verifyKunTokenWithUser(token))
}

export type AuthLoader = ReturnType<typeof createAuthLoader>
