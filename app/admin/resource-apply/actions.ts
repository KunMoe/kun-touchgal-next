import 'server-only'

import * as z from 'zod'
import { adminPaginationSchema } from '~/validations/admin'
import { getPatchResourceApply } from '~/app/api/admin/resource-apply/get'
import { getViewerContext } from '~/server/viewer/fromHeaders'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminPaginationSchema>
) => {
  const input = await parseSuperAdminAction(adminPaginationSchema, params)
  if (typeof input === 'string') {
    return input
  }

  const { contentLimit } = await (await getViewerContext()).visibility()

  const response = await getPatchResourceApply(input, contentLimit)
  return response
}
