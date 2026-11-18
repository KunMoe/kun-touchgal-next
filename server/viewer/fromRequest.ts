import { createViewerContext } from './context'
import type { NextRequest } from 'next/server'

// Route Handler 用: 每个请求建一次, 建好后往下传。再建一个就会再校验一次会话
export const viewerContextFromRequest = (req: NextRequest) =>
  createViewerContext(req.headers.get('cookie') ?? '')
