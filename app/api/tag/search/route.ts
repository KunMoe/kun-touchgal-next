import { NextRequest, NextResponse } from 'next/server'
import * as z from 'zod'
import { prisma } from '~/prisma'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { getAuthenticatedBlockedTagIds } from '~/app/api/utils/getBlockedTagIds'
import { searchTagSchema } from '~/validations/search'

const searchTag = async (
  input: z.infer<typeof searchTagSchema>,
  blockedTagIds: number[] = []
) => {
  const { query } = input

  const tags = await prisma.patch_tag.findMany({
    where: {
      ...(blockedTagIds.length ? { id: { notIn: blockedTagIds } } : {}),
      OR: query.map((q) => ({
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { alias: { has: q } }
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

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, searchTagSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const blockedTagIds = await getAuthenticatedBlockedTagIds(req)
  if (!blockedTagIds) {
    return NextResponse.json('用户未登录')
  }
  const response = await searchTag(input, blockedTagIds)
  return NextResponse.json(response)
}
