import { getPatchByCompanySchema } from '~/validations/company'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { getPatchByCompany } from './service'

export const GET = kunRoute.get({
  auth: 'optional',
  input: getPatchByCompanySchema,
  handler: async ({ req, input }) => {
    const view = await viewerContextFromRequest(req).listView()

    return getPatchByCompany(input, view)
  }
})
