import 'server-only'
import { getViewerContext } from '~/server/viewer/fromHeaders'

// 与 verifyHeaderCookie、视角上下文共用同一次会话校验
export const loadAuthUser = async () => {
  const session = await (await getViewerContext()).session()
  return session.kind === 'authenticated'
    ? { payload: session.payload, user: session.user }
    : null
}
