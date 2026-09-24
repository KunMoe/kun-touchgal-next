import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { getCompanySchema } from '~/validations/company'
import {
  getCachedCompanyList,
  getCompanyListCacheKey,
  setCompanyListCache
} from '../cache'
export const getCompany = async (input: z.infer<typeof getCompanySchema>) => {
  const { page, limit } = input
  const cacheKey = await getCompanyListCacheKey(input)
  const cached = await getCachedCompanyList(cacheKey)
  if (cached.response) {
    return cached.response
  }

  const offset = (page - 1) * limit

  const [companies, total] = await Promise.all([
    prisma.patch_company.findMany({
      take: limit,
      skip: offset,
      select: {
        id: true,
        name: true,
        count: true,
        alias: true
      },
      orderBy: { count: 'desc' }
    }),
    prisma.patch_company.count()
  ])

  const response = { companies, total }
  if (cacheKey && cached.canWrite) {
    await setCompanyListCache(cacheKey, response)
  }

  return response
}
