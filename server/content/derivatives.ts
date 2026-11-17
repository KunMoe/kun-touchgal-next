import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import type { Prisma } from '~/prisma/generated/prisma/client'

// 内容行删除之后, 清掉指向它们、还没有结论的审核任务与申诉 (已有结论的留作历史)。
// 两张表的 content_id 都没有外键, 级联删除带不走, 须用删除前收集的 id。
// 放在删除之后: 申诉提交会锁内容行, 这样并发提交的申诉不会成为孤儿。
// 评论通知不在这里清: 它要在评论行删除之前按行反推收件人, 见
// app/api/patch/comment/notifications.ts。整游戏 / 整号的级联删除不清评论通知,
// 那里留下的通知死链已裁定另案处理
export const purgeContentDerivatives = async (
  tx: Prisma.TransactionClient,
  ids: { comment?: number[]; rating?: number[]; resource?: number[] }
) => {
  const kinds = ['comment', 'rating', 'resource'] as const
  for (const kind of kinds) {
    const contentIds = ids[kind]
    if (contentIds) {
      await deletePendingModerationTasks(kind, contentIds, tx)
    }
  }
  for (const kind of kinds) {
    const contentIds = ids[kind]
    if (contentIds) {
      await deletePendingAppeals(kind, contentIds, tx)
    }
  }
}
