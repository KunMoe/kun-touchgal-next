import { NextResponse } from 'next/server'
import { kunAuthMiddleware } from '~/middleware/auth'
import { verifyKunCsrf } from '~/middleware/_csrf'
import type { NextRequest } from 'next/server'

export const config = {
  matcher: [
    '/admin/:path*',
    '/user/:path*',
    '/edit/:path*',
    // 全部 /api 都过 CSRF, 不设排除: 文件由浏览器经预签名 PUT 直传 S3, 上传接口只收小 JSON
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
