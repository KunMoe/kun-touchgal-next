import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { searchTagSchema } from '~/validations/search'

const searchTag = async (input: z.infer<typeof searchTagSchema>) => {
  const { query } = input

  const [tags, companies] = await Promise.all([
    prisma.patch_tag.findMany({
      where: {
        OR: query.flatMap((q) => [
          { name: { contains: q, mode: 'insensitive' } },
          { alias: { has: q } }
        ])
      },
      select: {
        id: true,
        name: true,
        count: true
      },
      orderBy: { count: 'desc' },
      take: 50
    }),
    prisma.patch_company.findMany({
      where: {
        OR: query.flatMap((q) => [
          { name: { contains: q, mode: 'insensitive' } },
          { alias: { has: q } },
          { parent_brand: { has: q } }
        ])
      },
      select: {
        id: true,
        name: true,
        count: true
      },
      orderBy: { count: 'desc' },
      take: 50
    })
  ])

  const suggestions = [
    ...tags.map((tag) => ({
      id: tag.id,
      type: 'tag' as const,
      mode: 'include' as const,
      name: tag.name,
      count: tag.count
    })),
    ...companies.map((company) => ({
      id: company.id,
      type: 'company' as const,
      mode: 'include' as const,
      name: company.name,
      count: company.count
    }))
  ]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 100)
    .map(({ id, type, mode, name }) => ({ id, type, mode, name }))

  return suggestions
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, searchTagSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }

  const response = await searchTag(input)
  return NextResponse.json(response)
}
