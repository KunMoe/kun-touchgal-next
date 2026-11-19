import 'server-only'

import * as z from 'zod'
import { cache } from 'react'
import { notFound } from 'next/navigation'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getCompanyById } from '~/app/api/company/service'
import { getPatchByCompany } from '~/app/api/company/galgame/service'
import {
  getCompanyByIdSchema,
  getPatchByCompanySchema
} from '~/validations/company'
import { getViewerContext } from '~/server/viewer/fromHeaders'

// 会社不存在或 id 越界时调 notFound(), 页面与 generateMetadata 共用同一次查询。这个路由段上方不能
// 加 loading.tsx 或 Suspense: 开始流式输出后状态码已定, 404 会退化成 200 + noindex
const getCachedCompanyOrNotFound = cache(async (companyId: number) => {
  const company = await getCompanyById({ companyId })
  if (!company) {
    notFound()
  }
  return company
})

export const kunGetCompanyByIdActions = async (
  params: z.infer<typeof getCompanyByIdSchema>
) => {
  const input = safeParseSchema(getCompanyByIdSchema, params)
  if (typeof input === 'string') {
    notFound()
  }

  return getCachedCompanyOrNotFound(input.companyId)
}

// 只有路由段里的会社 id 不合法才算不存在; 查询串校验失败与作品列表的失败仍以字符串返回
export const kunGetCompanyPageDataActions = async (
  params: z.infer<typeof getPatchByCompanySchema>
) => {
  const companyInput = safeParseSchema(getCompanyByIdSchema, {
    companyId: params.companyId
  })
  if (typeof companyInput === 'string') {
    notFound()
  }
  const input = safeParseSchema(getPatchByCompanySchema, params)
  if (typeof input === 'string') {
    // 会社不存在优先于查询串不合法: 否则页面是 200 的错误卡, generateMetadata 却抛 notFound
    await getCachedCompanyOrNotFound(companyInput.companyId)
    return input
  }

  const companyPromise = getCachedCompanyOrNotFound(input.companyId)
  const responseResultPromise = getViewerContext()
    .then((ctx) => ctx.listView())
    .then((view) => getPatchByCompany(input, view))
    .then(
      (response) => ({ status: 'fulfilled' as const, response }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    )
  const company = await companyPromise

  const responseResult = await responseResultPromise
  if (responseResult.status === 'rejected') {
    throw responseResult.error
  }
  if (typeof responseResult.response === 'string') {
    return responseResult.response
  }

  return { company, response: responseResult.response }
}
