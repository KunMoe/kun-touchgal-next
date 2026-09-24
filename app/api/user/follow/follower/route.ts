import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
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

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, getUserFollowStatusSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)

  const response = await getUserFollower(input, payload?.uid)
  return NextResponse.json(response)
}
