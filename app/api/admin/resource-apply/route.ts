import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminResourceApplyPaginationSchema } from '~/validations/admin'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getPatchResourceApply } from './get'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  legacyDeny: { unauthenticated: '未登录', forbidden: '仅超级管理员可访问' },
  input: adminResourceApplyPaginationSchema,
  handler: async ({ req, input }) => {
    const { contentLimit } = await viewerContextFromRequest(req).visibility()

    return getPatchResourceApply(input, contentLimit)
  }
})
