'use server'

import * as z from 'zod'
import { cache } from 'react'
import { safeParseSchema } from '~/utils/actions/safeParseSchema'
import { getCompanyById } from '~/app/api/company/service'
import { getPatchByCompany } from '~/app/api/company/galgame/service'
import {
  getCompanyByIdSchema,
  getPatchByCompanySchema
} from '~/validations/company'
import { getPatchVisibilityContext } from '~/utils/actions/getPatchVisibilityContext'

const getCachedCompanyById = cache((companyId: number) =>
  getCompanyById({ companyId })
)

export const kunGetCompanyByIdActions = async (
  params: z.infer<typeof getCompanyByIdSchema>
) => {
  const input = safeParseSchema(getCompanyByIdSchema, params)
  if (typeof input === 'string') {
    return input
  }

  return getCachedCompanyById(input.companyId)
}

export const kunGetCompanyPageDataActions = async (
  params: z.infer<typeof getPatchByCompanySchema>
) => {
  const input = safeParseSchema(getPatchByCompanySchema, params)
  if (typeof input === 'string') {
    return input
  }

  const companyPromise = getCachedCompanyById(input.companyId)
  const responseResultPromise = getPatchVisibilityContext()
    .then((visibility) => getPatchByCompany(input, visibility))
    .then(
      (response) => ({ status: 'fulfilled' as const, response }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    )
  const company = await companyPromise
  if (typeof company === 'string') {
    return company
  }

  const responseResult = await responseResultPromise
  if (responseResult.status === 'rejected') {
    throw responseResult.error
  }
  if (typeof responseResult.response === 'string') {
    return responseResult.response
  }

  return { company, response: responseResult.response }
}
