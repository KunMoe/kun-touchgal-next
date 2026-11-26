import { NextResponse } from 'next/server'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { kunLog } from '~/lib/log.server'
import { resolveUserSessionByToken } from '~/app/api/user/session/service'
import type { NextRequest } from 'next/server'

// 401 只表示会话确实无效 (客户端据此清掉登录态); Redis 或库不可用时回 503,
// 客户端按「暂时连不上」处理, 保留登录态
const getUserSession = async (req: NextRequest) => {
  const resolution = await resolveUserSessionByToken(
    req.cookies.get('kun-galgame-patch-moe-token')?.value ?? ''
  )
  if (resolution.kind === 'authenticated') {
    return NextResponse.json(resolution.session)
  }
  if (resolution.kind === 'unavailable') {
    kunLog('auth.session_unavailable', { source: 'api' }, resolution.cause)
    return NextResponse.json('会话服务暂时不可用', { status: 503 })
  }
  return NextResponse.json('用户登录失效', { status: 401 })
}

// 会话探测要分清无效与暂时不可用 (三态), 自己解析令牌, 不经 kunRoute 的会话解析
export const GET = kunRoute.get({
  auth: 'public',
  handler: ({ req }) => getUserSession(req)
})
