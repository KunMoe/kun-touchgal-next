import { kunRoute } from '~/app/api/utils/kunRoute'
import { handleOidcCallback } from '~/lib/oidc/webToNode'
import type { NextRequest } from 'next/server'

// oidc-provider 依赖 Node.js API（Koa/http），必须跑在 Node runtime，不能进 Edge。
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 原样透传给 oidc-provider: 授权、令牌、登出等端点各自按协议认客户端凭据与 provider 会话,
// 不读站点会话; 请求体也由 provider 自己读
const handler = ({ req }: { req: NextRequest }) => handleOidcCallback(req)

export const GET = kunRoute.get({ auth: 'public', handler })
export const POST = kunRoute.post({ auth: 'public', handler })
export const PUT = kunRoute.put({ auth: 'public', handler })
export const DELETE = kunRoute.delete({ auth: 'public', handler })
export const PATCH = kunRoute.patch({ auth: 'public', handler })
export const HEAD = kunRoute.head({ auth: 'public', handler })
export const OPTIONS = kunRoute.options({ auth: 'public', handler })
