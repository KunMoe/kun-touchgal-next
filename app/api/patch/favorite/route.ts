import { z } from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { togglePatchFavoriteSchema } from '~/validations/patch'
import { createDedupMessage } from '~/app/api/utils/message'
import { invalidateUnread } from '~/app/api/message/unread/cache'
import {
  invalidatePatchFavoriteCache,
  invalidatePatchContentCache
} from '../cache'

// 通告锁命名空间 (pg_advisory_xact_lock 首参): 与 patch type (481001) / 评分统计
// (481002) 锁分属不同域, 互不阻塞. folder 私有于用户, 同一 (folder, patch) 的并发
// toggle 必共享 folderId, 故按 (域, folderId) 串行即精确覆盖竞态, 且不牵连跨用户/跨夹
const FAVORITE_LOCK_NAMESPACE = 481003

const togglePatchFavorite = async (
  input: z.infer<typeof togglePatchFavoriteSchema>,
  uid: number
) => {
  const [patch, folder] = await Promise.all([
    prisma.patch.findUnique({
      where: { id: input.patchId },
      select: { user_id: true, name: true, unique_id: true }
    }),
    prisma.user_patch_favorite_folder.findUnique({
      where: { id: input.folderId },
      select: { user_id: true }
    })
  ])
  if (!patch) {
    return '未找到 Galgame'
  }
  if (!folder) {
    return '未找到收藏文件夹'
  }
  if (folder.user_id !== uid) {
    return '这不是您的收藏夹'
  }

  const messageData = {
    type: 'favorite' as const,
    content: patch.name,
    sender_id: uid,
    recipient_id: patch.user_id,
    link: `/${patch.unique_id}?folderId=${input.folderId}`
  }

  // deleteMany + createMany(skipDuplicates) 使并发双击不会触发 P2002/P2025
  const response = await prisma
    .$transaction(async (tx) => {
      // 串行化同一收藏夹的并发 toggle: 拿锁后 deleteMany 读到的是已提交状态, 使 toggle
      // 恢复可线性化并顺带消除重复通知. ::int 显式定型以匹配 (int, int) 重载 (pg adapter
      // 原生参数默认 text, 缺 cast 会命中不存在的 (text, text) 重载报 42883)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${FAVORITE_LOCK_NAMESPACE}::int, ${input.folderId}::int)`

      const removed = await tx.user_patch_favorite_folder_relation.deleteMany({
        where: {
          folder_id: input.folderId,
          patch_id: input.patchId
        }
      })
      if (removed.count > 0) {
        if (patch.user_id !== uid) {
          await tx.user_message.deleteMany({
            where: {
              type: 'favorite',
              sender_id: uid,
              recipient_id: patch.user_id,
              link: messageData.link
            }
          })
        }
        // 按钮态是「在用户任一收藏夹内」的跨夹聚合, 单夹 toggle 结果推不出, 事务内回查
        const remaining =
          await tx.user_patch_favorite_folder_relation.findFirst({
            where: { patch_id: input.patchId, folder: { user_id: uid } },
            select: { id: true }
          })
        return { added: false, isFavorite: Boolean(remaining) }
      }

      await tx.user_patch_favorite_folder_relation.createMany({
        data: {
          folder_id: input.folderId,
          patch_id: input.patchId
        },
        skipDuplicates: true
      })
      if (patch.user_id !== uid) {
        await createDedupMessage(messageData, tx)
      }
      return { added: true, isFavorite: true }
    })
    .catch((error: unknown) => {
      // 事务内任一外键的引用行被并发删除都会命中约束, 无法区分是哪一条, 返回通用文案
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        return '收藏失败, 请重试'
      }
      throw error
    })
  if (typeof response === 'string') {
    return response
  }

  try {
    await Promise.all([
      invalidatePatchFavoriteCache(patch.unique_id, uid),
      invalidatePatchContentCache(patch.unique_id)
    ])
  } catch {
    // 缓存失效失败不影响收藏结果
  }

  // 提交后失效补丁作者未读缓存 (L-01): 收藏发通知 / 取消收藏删通知都改变其未读态,
  // 事务内失效会被并发读回填旧值; 自收藏不产生通知
  if (patch.user_id !== uid) {
    await invalidateUnread(patch.user_id).catch(() => undefined)
  }

  return response
}

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, togglePatchFavoriteSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await togglePatchFavorite(input, payload.uid)
  return NextResponse.json(response)
}
