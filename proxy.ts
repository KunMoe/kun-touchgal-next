import { NextResponse } from 'next/server'
import { kunAuthMiddleware } from '~/middleware/auth'
import { verifyKunCsrf } from '~/middleware/_csrf'
import type { NextRequest } from 'next/server'

export const config = {
  matcher: [
    '/admin/:path*',
    '/user/:path*',
    '/edit/:path*',
    // 全部 /api 都过 CSRF, 不设排除: 文件由浏览器经预签名 PUT 直传 S3, 上传接口只收小 JSON。
    // 命中这里的写请求, Next 为 proxy 克隆请求体, 交给 handler 之前收完整段并截断在
    // KUN_PROXY_BODY_CLONE_LIMIT (constants/bodyBudget.ts); 各入口自己的字节预算写在 kunRoute 的 maxBytes
    '/api/:path*'
  ]
}

export const proxy = async (request: NextRequest) => {
  if (request.nextUrl.pathname.startsWith('/api')) {
    const csrfError = verifyKunCsrf(request)
    if (csrfError) {
      return NextResponse.json(csrfError, { status: 403 })
    }
    return NextResponse.next()
  }

  return kunAuthMiddleware(request)
}
