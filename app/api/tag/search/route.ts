import * as z from 'zod'
import { prisma } from '~/prisma'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { viewerContextFromRequest } from '~/server/viewer/fromRequest'
import { termAliasFilter } from '~/server/term/match'
import { searchTagSchema } from '~/validations/search'

const searchTag = async (
  input: z.infer<typeof searchTagSchema>,
  blockedTagIds: readonly number[]
) => {
  const { query } = input

  const tags = await prisma.patch_tag.findMany({
    where: {
      ...(blockedTagIds.length ? { id: { notIn: [...blockedTagIds] } } : {}),
      OR: query.map((q) => ({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { alias: termAliasFilter(q) }
        ]
      }))
    },
    select: {
      id: true,
      name: true,
      count: true,
      alias: true
    },
    orderBy: { count: 'desc' },
    take: 100
  })

  return tags
}

export const POST = kunRoute.post({
  auth: 'user',
  input: searchTagSchema,
  handler: async ({ req, input }) => {
    const { blockedTagIds } = await viewerContextFromRequest(req).visibility()
    return searchTag(input, blockedTagIds)
  }
})
