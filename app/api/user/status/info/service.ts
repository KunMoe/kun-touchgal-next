import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { getUserProfileSchema } from '~/validations/user'
import type { KunViewer } from '~/app/api/utils/contentVisibility'
import type { UserInfo } from '~/types/api/user'

export const getUserProfile = async (
  input: z.infer<typeof getUserProfileSchema>,
  viewer: KunViewer | null
) => {
  const currentUserUid = viewer?.uid ?? 0
  const isSelf = currentUserUid === input.id
  const [data, userFavoritePatchCount, followRelation] = await Promise.all([
    prisma.user.findUnique({
      where: { id: input.id },
      include: {
        _count: {
          select: {
            patch_resource: true,
            patch: true,
            patch_comment: true,
            patch_rating: true,
            follower: true,
            following: true
          }
        }
      }
    }),
    prisma.user_patch_favorite_folder_relation.count({
      where: { folder: { user_id: input.id } }
    }),
    currentUserUid && !isSelf
      ? prisma.user_follow_relation.findUnique({
          where: {
            follower_id_following_id: {
              follower_id: currentUserUid,
              following_id: input.id
            }
          },
          select: { id: true }
        })
      : null
  ])
  if (!data) {
    return '未找到用户'
  }

  // 关系命名与语义相反: user.following 是关注此用户的关系行, user.follower 是此用户关注他人的关系行
  const {
    follower: followingCount,
    following: followerCount,
    ...count
  } = data._count

  const user: UserInfo = {
    id: data.id,
    requestUserUid: currentUserUid,
    name: data.name,
    email: isSelf ? data.email : '',
    avatar: data.avatar,
    bio: data.bio,
    role: data.role,
    status: data.status,
    registerTime: String(data.register_time),
    moemoepoint: data.moemoepoint,
    follower: followerCount,
    following: followingCount,
    isFollow: Boolean(followRelation),
    _count: {
      ...count,
      patch_favorite: userFavoritePatchCount
    }
  }

  return user
}
