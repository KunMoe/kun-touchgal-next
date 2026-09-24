import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createDedupMessage } from '~/app/api/utils/message'
import { invalidateResourceStatsListCache } from '~/app/api/resource/cache'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateUserSession } from '~/app/api/user/session/cache'
import { invalidateUnread } from '~/app/api/message/unread/cache'

const resourceIdSchema = z.object({
  resourceId: z.coerce
    .number({ message: '资源 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

// 通告锁命名空间: 见 app/api/patch/rating/like/route.ts 的说明, 三条点赞路由共用
const LIKE_LOCK_NAMESPACE = 481004

const toggleResourceLike = async (
  input: z.infer<typeof resourceIdSchema>,
  uid: number
) => {
  const { resourceId } = input

  const resource = await prisma.patch_resource.findUnique({
    where: { id: resourceId },
    include: {
      patch: { select: { name: true, unique_id: true } }
    }
  })
  if (!resource) {
    return '未找到资源'
  }
  if (resource.user_id === uid) {
    return '您不能给自己点赞'
  }
  // 待初次审核 (status=2) / 待审核 (status=3) 的资源不可点赞;
  // 隐藏 (status=1) 的资源前端不可见, 与不存在等同
  if (resource.status === 2 || resource.status === 3) {
    return '该资源正在审核中, 暂时无法点赞'
  }
  if (resource.status !== 0) {
    return '未找到资源'
  }

  const messageData = {
    type: 'like' as const,
    content: `赞了您在「${resource.patch.name}」下发布的资源`,
    sender_id: uid,
    recipient_id: resource.user_id,
    link: `/${resource.patch.unique_id}?tab=resources&resourceSection=${resource.section}&resourceId=${resource.id}`
  }

  // deleteMany + createMany(skipDuplicates) 使并发双击不会触发 P2002/P2025
  const response = await prisma
    .$transaction(async (tx) => {
      // 串行化同一用户的并发 toggle, 理由与 ::int 强转的必要性见 rating/like/route.ts
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LIKE_LOCK_NAMESPACE}::int, ${uid}::int)`

      const removed = await tx.user_patch_resource_like_relation.deleteMany({
        where: {
          user_id: uid,
          resource_id: resourceId
        }
      })
      const isRemoved = removed.count > 0
      if (isRemoved) {
        await tx.user_message.deleteMany({
          where: {
            type: 'like',
            sender_id: uid,
            recipient_id: resource.user_id,
            link: messageData.link
          }
        })
      } else {
        await tx.user_patch_resource_like_relation.createMany({
          data: {
            user_id: uid,
            resource_id: resourceId
          },
          skipDuplicates: true
        })
        await createDedupMessage(messageData, tx)
      }

      await tx.user.update({
        where: { id: resource.user_id },
        data: { moemoepoint: { increment: isRemoved ? -1 : 1 } }
      })

      return !isRemoved
    })
    .catch((error: unknown) => {
      // 外键命中 = 引用行被并发删除, 取舍同 rating/like/route.ts
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        return '未找到资源'
      }
      throw error
    })

  if (typeof response === 'string') {
    return response
  }

  await invalidateUserSession(resource.user_id)
  // 点赞创建通知、取消点赞删除通知, 两支都改资源作者的未读状态, 提交后失效 (L-01)
  await invalidateUnread(resource.user_id).catch(() => undefined)
  await invalidateResourceStatsListCache()
  // 详情缓存内嵌 likeCount 且版本键按 patch 分片, 全站 stats 版本不再覆盖它
  await invalidatePatchResourceDetailCache(resource.patch_id)
  return response
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, resourceIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await toggleResourceLike(input, payload.uid)
  return NextResponse.json(response)
}
