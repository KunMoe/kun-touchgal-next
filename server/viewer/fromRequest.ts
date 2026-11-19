import { createViewerContext } from './context'
import type { NextRequest } from 'next/server'
import type { ViewerContext } from './context'

const contexts = new WeakMap<NextRequest, ViewerContext>()

// Route Handler 用。同一个请求对象只建一个上下文: kunRoute 先经 verifyHeaderCookie 解析出
// actor, handler 再取可见性时拿到的是同一个上下文, 会话只校验一次
export const viewerContextFromRequest = (req: NextRequest) => {
  let context = contexts.get(req)
  if (!context) {
    context = createViewerContext(req.headers.get('cookie') ?? '')
    contexts.set(req, context)
  }
  return context
}
