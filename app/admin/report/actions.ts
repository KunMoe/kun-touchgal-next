'use server'

import * as z from 'zod'
import { adminReportPaginationSchema } from '~/validations/admin'
import { getReport } from '~/app/api/admin/report/service'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminReportPaginationSchema>
) => {
  const input = await parseSuperAdminAction(adminReportPaginationSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const response = await getReport(input)
  return response
}
