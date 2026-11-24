import * as z from 'zod'
import { prisma } from '~/prisma'
import { searchCompanySchema } from '~/validations/company'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { termAliasFilter } from '~/server/term/match'

const searchCompany = async (input: z.infer<typeof searchCompanySchema>) => {
  const { query } = input

  const companies = await prisma.patch_company.findMany({
    where: {
      AND: query.map((q) => ({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { alias: termAliasFilter(q) },
          { parent_brand: termAliasFilter(q) }
        ]
      }))
    },
    select: {
      id: true,
      name: true,
      count: true,
      alias: true
    },
    take: 100
  })

  const fullQuery = query.join(' ').toLowerCase()
  return companies.sort((a, b) => {
    const nameA = a.name.toLowerCase()
    const nameB = b.name.toLowerCase()
    const scoreA = nameA === fullQuery ? 0 : nameA.startsWith(fullQuery) ? 1 : 2
    const scoreB = nameB === fullQuery ? 0 : nameB.startsWith(fullQuery) ? 1 : 2
    if (scoreA !== scoreB) return scoreA - scoreB
    return b.count - a.count
  })
}

export const POST = kunRoute.post({
  auth: 'public',
  input: searchCompanySchema,
  handler: ({ input }) => searchCompany(input)
})
