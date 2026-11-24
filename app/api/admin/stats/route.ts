import * as z from 'zod'
import { kunInt } from '~/validations/primitives'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import type { OverviewData } from '~/types/api/admin'

const daysSchema = z.object({
  days: kunInt(1, 60, '统计天数须为 1～60 的整数')
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

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  input: daysSchema,
  handler: ({ input }) => getOverviewData(input.days)
})
