import 'server-only'

import { cache } from 'react'
import { notFound } from 'next/navigation'
import * as z from 'zod'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getPatchResourceDetail } from '~/app/api/patch/resource/detail'

const resourceIdSchema = z.object({
  resourceId: z.coerce.number().min(1).max(9999999)
})

// 资源不存在、对当前视角不可见或 id 越界时调 notFound(), 页面与 generateMetadata 共用。这个路由段
// 上方不能加 loading.tsx 或 Suspense: 开始流式输出后状态码已定, 404 会退化成 200 + noindex
export const kunGetResourceDetailActions = cache(async (resourceId: number) => {
  const input = safeParseSchema(resourceIdSchema, { resourceId })
  if (typeof input === 'string') {
    notFound()
  }
  const payload = await verifyHeaderCookie()

  const response = await getPatchResourceDetail(input.resourceId, payload)
  if (!response) {
    notFound()
  }
  return response
})
