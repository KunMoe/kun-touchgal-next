import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'

const uidSchema = z.object({
  uid: z.coerce.number({ message: '请输入合法的用户 ID' }).min(1).max(9999999)
})

const unfollowUser = async (uid: number, currentUserUid: number) => {
  if (uid === currentUserUid) {
    return '您不能取消关注自己'
  }

  // deleteMany 幂等: 关系已在别处被取消时 count 为 0 而非抛 P2025 → 500
  await prisma.user_follow_relation.deleteMany({
    where: {
      follower_id: currentUserUid,
      following_id: uid
    }
  })

  return {}
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, uidSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await unfollowUser(input.uid, payload?.uid)
  return NextResponse.json(response)
}
