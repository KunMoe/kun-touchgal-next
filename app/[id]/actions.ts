import 'server-only'

import { cache } from 'react'
import { notFound } from 'next/navigation'
import * as z from 'zod'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getPatchPageData } from '~/app/api/patch/pageData'
import { updatePatchViews } from '~/app/api/patch/views/put'

const uniqueIdSchema = z.object({
  uniqueId: z.string().min(8).max(8)
})

// 作品不存在或 id 形状不对时调 notFound(), 页面与 generateMetadata 共用。这个路由段上方不能
// 加 loading.tsx 或 Suspense: 开始流式输出后状态码已定, 404 会退化成 200 + noindex
export const kunGetPatchPageDataActions = cache(async (uniqueId: string) => {
  const input = safeParseSchema(uniqueIdSchema, { uniqueId })
  if (typeof input === 'string') {
    notFound()
  }
  const payload = await verifyHeaderCookie()

  const response = await getPatchPageData(input, payload)
  if (!response) {
    notFound()
  }
  return response
})

export const kunUpdatePatchViewsActions = async (
  params: z.infer<typeof uniqueIdSchema>
) => {
  const input = safeParseSchema(uniqueIdSchema, params)
  if (typeof input === 'string') {
    return input
  }

  await updatePatchViews(input.uniqueId)
}
