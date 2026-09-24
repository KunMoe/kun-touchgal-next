import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { prisma } from '~/prisma/index'
import { searchUserSchema } from '~/validations/user'

const searchUser = async (input: z.infer<typeof searchUserSchema>) => {
  const { query } = input

  const users: KunUser[] = await prisma.user.findMany({
    where: {
      name: { contains: query, mode: 'insensitive' }
    },
    select: {
      id: true,
      name: true,
      avatar: true
    },
    take: 10
  })

  return users
}

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, searchUserSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload?.uid) {
    return NextResponse.json('用户未登录')
  }

  const response = await searchUser(input)
  return NextResponse.json(response)
}
