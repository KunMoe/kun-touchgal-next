import { getCompanySchema } from '~/validations/company'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { getCompany } from './service'

export const GET = kunRoute.get({
  auth: 'public',
  input: getCompanySchema,
  handler: ({ input }) => getCompany(input)
})
