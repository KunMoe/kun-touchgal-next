import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createDedupMessage } from '~/app/api/utils/message'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import { PatchRefSelectField } from '~/constants/api/select'

const ratingIdSchema = z.object({
  ratingId: z.coerce.number({ message: 'ID 不正确' }).min(1).max(9999999)
})

// 通告锁命名空间 (pg_advisory_xact_lock 首参): 与 patch type (481001) / 评分统计
// (481002) / 收藏 (481003) 分属不同域. 评价 / 评论 / 资源三条点赞路由共用 481004,
// 第二参为点赞者 uid: toggle 键是 (user, target), 同一用户的并发请求必共享 uid, 故按
// uid 串行即精确覆盖竞态, 且不牵连热门目标下其他用户的点赞
const LIKE_LOCK_NAMESPACE = 481004

const toggleRatingLike = async (
  input: z.infer<typeof ratingIdSchema>,
  uid: number
) => {
  const { ratingId } = input

  const rating = await prisma.patch_rating.findUnique({
    where: { id: ratingId },
    include: { patch: { select: PatchRefSelectField } }
  })
  if (!rating) {
    return '评价不存在'
  }
  if (rating.user_id === uid) {
    return '您不能给自己点赞'
  }
  // 待审核 (status=1) 的评价不可点赞; 隐藏 (status=2) 的评价前端不可见, 与不存在等同
  if (rating.status === 1) {
    return '该评价正在审核中, 暂时无法点赞'
  }
  if (rating.status !== 0) {
    return '评价不存在'
  }

  const messageData = {
    type: 'like' as const,
    content: `赞了您的评价：${rating.short_summary.slice(0, 107)}`,
    sender_id: uid,
    recipient_id: rating.user_id,
    link: `/${rating.patch.unique_id}?tab=rating&ratingId=${rating.id}`
  }

  // deleteMany + createMany(skipDuplicates) 使并发双击不会触发 P2002/P2025
  const response = await prisma
    .$transaction(async (tx) => {
      // 串行化同一用户的并发 toggle: 拿锁后 deleteMany 读到的是已提交状态, 使 toggle
      // 恢复可线性化 (READ COMMITTED 下删不存在的行不持锁, 无锁时两个并发请求会双双
      // 落进 create 分支). ::int 显式定型以匹配 (int, int) 重载 (pg adapter 原生参数
      // 默认 text, 缺 cast 会命中不存在的 (text, text) 重载报 42883)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LIKE_LOCK_NAMESPACE}::int, ${uid}::int)`

      const removed = await tx.patch_rating_like.deleteMany({
        where: {
          patch_rating_id: ratingId,
          user_id: uid
        }
      })
      const isRemoved = removed.count > 0
      if (isRemoved) {
        await tx.user_message.deleteMany({
          where: {
            type: 'like',
            sender_id: uid,
            recipient_id: rating.user_id,
            link: messageData.link
          }
        })
      } else {
        await tx.patch_rating_like.createMany({
          data: {
            patch_rating_id: ratingId,
            user_id: uid
          },
          skipDuplicates: true
        })
        await createDedupMessage(messageData, tx)
      }

      await tx.user.update({
        where: { id: rating.user_id },
        data: { moemoepoint: { increment: isRemoved ? -1 : 1 } }
      })

      return !isRemoved
    })
    .catch((error: unknown) => {
      // 外键命中 = 引用行被并发删除. 事务内的外键不止评价一处, 但点赞者/收件人被删时
      // 请求本身已无意义, 故用指向性文案而非 favorite 那样的通用文案
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        return '评价不存在'
      }
      throw error
    })

  if (typeof response === 'string') {
    return response
  }

  await invalidateUserSession(rating.user_id)
  // 点赞创建通知、取消点赞删除通知, 两支都改评价作者的未读状态, 提交后失效 (L-01)
  await invalidateUnread(rating.user_id).catch(() => undefined)
  return response
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, ratingIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('请先登录')
  }

  const response = await toggleRatingLike(input, payload.uid)
  return NextResponse.json(response)
}
