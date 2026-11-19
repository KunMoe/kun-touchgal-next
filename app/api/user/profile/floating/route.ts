import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import type { KunViewer } from '~/app/api/utils/contentVisibility'
import type { FloatingCardUser } from '~/types/api/user'

const uidSchema = z.object({
  uid: z.coerce.number().min(1).max(9999999)
})

const getUserFloatingProfile = async (
  input: z.infer<typeof uidSchema>,
  viewer: KunViewer | null
) => {
  const currentUserUid = viewer?.uid ?? 0
  const [data, followRelation] = await Promise.all([
    prisma.user.findUnique({
      where: { id: input.uid },
      select: {
        id: true,
        name: true,
        avatar: true,
        bio: true,
        moemoepoint: true,
        role: true,
        _count: {
          select: {
            following: true,
            patch: true,
            patch_resource: true
          }
        }
      }
    }),
    currentUserUid && currentUserUid !== input.uid
      ? prisma.user_follow_relation.findUnique({
          where: {
            follower_id_following_id: {
              follower_id: currentUserUid,
              following_id: input.uid
            }
          },
          select: { id: true }
        })
      : null
  ])
  if (!data) {
    return '未找到用户'
  }

  const user: FloatingCardUser = {
    id: data.id,
    name: data.name,
    avatar: data.avatar,
    bio: data.bio,
    moemoepoint: data.moemoepoint,
    role: data.role,
    isFollow: Boolean(followRelation),
    // 关系命名与语义相反: user.following 是关注此用户的关系行, 即粉丝数
    _count: {
      follower: data._count.following,
      patch: data._count.patch,
      patch_resource: data._count.patch_resource
    }
  }

  return user
}

export const GET = kunRoute.get({
  auth: 'optional',
  input: uidSchema,
  handler: async ({ input, actor: payload }) =>
    getUserFloatingProfile(input, payload)
})
