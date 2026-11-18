import 'server-only'

import * as z from 'zod'
import { adminResourcePaginationSchema } from '~/validations/admin'
import { getPatchResource } from '~/app/api/admin/resource/get'
import { getViewerContext } from '~/server/viewer/fromHeaders'
import { parseSuperAdminAction } from '~/utils/actions/parseSuperAdminAction'

export const kunGetActions = async (
  params: z.infer<typeof adminResourcePaginationSchema>
) => {
  const input = await parseSuperAdminAction(
    adminResourcePaginationSchema,
    params
  )
  if (typeof input === 'string') {
    return input
  }

  const { contentLimit } = await (await getViewerContext()).visibility()

  const response = await getPatchResource(input, contentLimit)
  return response
}
