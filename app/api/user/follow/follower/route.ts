import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { getUserFollowStatusSchema } from '~/validations/user'
import type { UserFollow } from '~/types/api/user'

const getUserFollower = async (
  input: z.infer<typeof getUserFollowStatusSchema>,
  currentUserUid: number | undefined
) => {
  const { uid, page, limit } = input
  const offset = (page - 1) * limit

  const [data, total] = await Promise.all([
    prisma.user_follow_relation.findMany({
      take: limit,
      skip: offset,
      where: { following_id: uid },
      select: {
        follower: {
          select: {
            id: true,
            name: true,
            avatar: true,
            bio: true,
            _count: {
              select: {
                follower: true,
                following: true
              }
            }
          }
        }
      }
    }),
    prisma.user_follow_relation.count({
      where: { following_id: uid }
    })
  ])

  const followerIds = data.map((relation) => relation.follower.id)
  const followedIds =
    currentUserUid && followerIds.length
      ? new Set(
          (
            await prisma.user_follow_relation.findMany({
              where: {
                follower_id: currentUserUid,
                following_id: { in: followerIds }
              },
              select: { following_id: true }
            })
          ).map((relation) => relation.following_id)
        )
      : new Set<number>()

  const followers: UserFollow[] = data.map((relation) => ({
    id: relation.follower.id,
    name: relation.follower.name,
    avatar: relation.follower.avatar,
    bio: relation.follower.bio,
    follower: relation.follower._count.following,
    following: relation.follower._count.follower,
    isFollow: followedIds.has(relation.follower.id)
  }))

  return { followers, total }
}

// 关注关系图与个人主页同样只给登录用户看 (X02-02 站长裁定); 游客按 uid 遍历就能导出全站的关注关系
export const GET = kunRoute.get({
  auth: 'user',
  input: getUserFollowStatusSchema,
  handler: async ({ input, actor }) => getUserFollower(input, actor.uid)
})
