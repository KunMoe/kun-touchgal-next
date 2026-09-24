'use server'

import * as z from 'zod'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getCompanySchema } from '~/validations/company'
import { getCompany } from '~/app/api/company/all/service'

export const kunGetActions = async (
  params: z.infer<typeof getCompanySchema>
) => {
  const input = safeParseSchema(getCompanySchema, params)
  if (typeof input === 'string') {
    return input
  }

  const response = await getCompany(input)
  return response
}
