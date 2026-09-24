import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
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

export async function GET(req: NextRequest) {
  const input = kunParseGetQuery(req, uidSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)

  const user = await getUserFloatingProfile(input, payload)
  return NextResponse.json(user)
}
