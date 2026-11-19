import { NextRequest, NextResponse } from 'next/server'
import { resolveUserSessionByToken } from '~/app/api/user/session/service'

// 401 只表示会话确实无效 (客户端据此清掉登录态); Redis 或库不可用时回 503,
// 客户端按「暂时连不上」处理, 保留登录态
export const GET = async (req: NextRequest) => {
  const resolution = await resolveUserSessionByToken(
    req.cookies.get('kun-galgame-patch-moe-token')?.value ?? ''
  )
  if (resolution.kind === 'authenticated') {
    return NextResponse.json(resolution.session)
  }
  if (resolution.kind === 'unavailable') {
    // eslint-disable-next-line no-console
    console.error('User session service unavailable:', resolution.cause)
    return NextResponse.json('会话服务暂时不可用', { status: 503 })
  }
  return NextResponse.json('用户登录失效', { status: 401 })
}
