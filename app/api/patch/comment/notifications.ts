import type { Prisma } from '~/prisma/generated/prisma/client'
import { buildCommentLink } from '~/utils/patch/buildCommentLink'

// 删除评论 (及级联带走的整棵回复子树) 前, 清理指向这些评论的全部站内信。
// 挂在评论 link 上的通知全仓只有三类: comment (回复 / 资源一级评论)、
// like (评论点赞)、mention (正文提及)。评论行删除会级联带走点赞关系行, 此后
// 取消点赞再也触发不到 like 通知的清理, 不在此显式删除即成永久死链通知——
// 与 cleanupResourceCommentDerivatives 按 link 整删三类是同一口径。
//
// user_message 的索引全部以 recipient_id 打头, 另有单列 sender_id, link/type 无索引
// (不加 link 索引是刻意取舍: 热表每条通知插入的写放大 + 又一条 prod 迁移), 纯 type+link
// 条件会退化为全表顺扫, 故按锚点拆两条语句, 各自锁定一个可用索引,
// 语义仍由 type+link 保证, 锚点只做窄化:
//   comment/like: recipient 可完备推导 (父作者 / 资源上传者 / 评论作者本人)
//   mention:      recipient 是被提及者, 不可枚举 (编辑移除提及后无从反推正文),
//                 但 sender 恒为评论作者
// 须在评论行删除之前、与删除同一事务内调用; unique_id 按行取以支持跨补丁批量删除
export const cleanupCommentNotifications = async (
  tx: Prisma.TransactionClient,
  commentIds: number[]
) => {
  const rows = await tx.patch_comment.findMany({
    where: { id: { in: commentIds } },
    select: {
      id: true,
      user_id: true,
      parent_id: true,
      resource_id: true,
      parent: { select: { user_id: true } },
      resource: { select: { user_id: true } },
      patch: { select: { unique_id: true } }
    }
  })
  if (!rows.length) {
    return
  }

  const links: string[] = []
  // 评论作者既是 like 通知的收件人, 也是 mention 通知的发送者
  const authorIds = new Set<number>()
  const recipientIds = new Set<number>()
  for (const row of rows) {
    links.push(buildCommentLink(row.patch.unique_id, row.id, row.resource_id))
    authorIds.add(row.user_id)
    recipientIds.add(row.user_id)
    // 生产点推导: 回复→父作者, 资源一级评论→上传者 (resource_id 按行取以兼容存量数据)
    if (row.parent) {
      recipientIds.add(row.parent.user_id)
    }
    if (!row.parent_id && row.resource) {
      recipientIds.add(row.resource.user_id)
    }
  }

  await tx.user_message.deleteMany({
    where: {
      type: { in: ['comment', 'like'] },
      recipient_id: { in: [...recipientIds] },
      link: { in: links }
    }
  })
  await tx.user_message.deleteMany({
    where: {
      type: 'mention',
      sender_id: { in: [...authorIds] },
      link: { in: links }
    }
  })
}
