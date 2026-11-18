import 'server-only'

import * as z from 'zod'
import { adminPaginationSchema } from '~/validations/admin'
import { getGalgame } from '~/app/api/admin/galgame/service'
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

  const response = await getGalgame(input, contentLimit)
  return response
}
