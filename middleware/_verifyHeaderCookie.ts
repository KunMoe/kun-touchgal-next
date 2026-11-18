import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import type { NextRequest } from 'next/server'

// 只要会话 payload 的入口沿用这个适配器; 同一个请求里还要视角 (可见性、列表缓存) 的入口
// 直接建一个 viewerContextFromRequest(req) 往下传, 不要两个都调 (会校验两次会话)
export const verifyHeaderCookie = (req: NextRequest) =>
  viewerContextFromRequest(req).viewer()
