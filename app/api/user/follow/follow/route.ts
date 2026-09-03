import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createDedupMessage } from '~/app/api/utils/message'
import { invalidateUnread } from '~/app/api/message/unread/cache'

const uidSchema = z.object({
  uid: z.coerce.number({ message: '请输入合法的用户 ID' }).min(1).max(9999999)
})

const followUser = async (uid: number, currentUserUid: number) => {
  if (uid === currentUserUid) {
    return '您不能关注自己'
  }

  const response = await prisma.$transaction(async (prisma) => {
    // skipDuplicates 幂等: 多标签页/并发重复关注返回成功而非 P2002 → 500,
    // 客户端状态自然收敛为「已关注」; count 守卫使重复请求不发通知
    const { count } = await prisma.user_follow_relation.createMany({
      data: [
        {
          follower_id: currentUserUid,
          following_id: uid
        }
      ],
      skipDuplicates: true
    })

    if (count) {
      await createDedupMessage(
        {
          type: 'follow',
          content: '关注了您',
          sender_id: currentUserUid,
          recipient_id: uid,
          link: `/user/${currentUserUid}/comment`
        },
        prisma
      )
    }

    return {}
  })

  // 提交后失效被关注者未读缓存 (L-01): 事务内失效会被并发读回填旧值;
  // 重复关注 (count 0) 不发通知, 多一次 DEL 无害
  await invalidateUnread(uid).catch(() => undefined)
  return response
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

  const response = await followUser(input.uid, payload?.uid)
  return NextResponse.json(response)
}
