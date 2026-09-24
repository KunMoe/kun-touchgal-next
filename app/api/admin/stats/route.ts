import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import type { OverviewData } from '~/types/api/admin'

const daysSchema = z.object({
  days: z.coerce
    .number({ message: '天数必须为数字' })
    .min(1)
    .max(60, { message: '最多展示 60 天的数据' })
})

const getOverviewData = async (days: number): Promise<OverviewData> => {
  const time = new Date()
  time.setDate(time.getDate() - days)

  const [newUser, newActiveUser, newGalgame, newGalgameResource, newComment] =
    await Promise.all([
      prisma.user.count({
        where: {
          created: {
            gte: time
          }
        }
      }),
      prisma.user.count({
        where: {
          last_login_time: {
            gte: time.getTime().toString()
          }
        }
      }),
      prisma.patch.count({
        where: {
          created: {
            gte: time
          }
        }
      }),
      prisma.patch_resource.count({
        where: {
          created: {
            gte: time
          }
        }
      }),
      prisma.patch_comment.count({
        where: {
          created: {
            gte: time
          }
        }
      })
    ])

  return { newUser, newActiveUser, newGalgame, newGalgameResource, newComment }
}

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, daysSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (payload.role < 4) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const data = await getOverviewData(input.days)
  return NextResponse.json(data)
}
