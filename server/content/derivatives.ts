import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { deletePendingAppeals } from '~/server/moderation/appeal'
import type { KunTx } from '~/prisma/index'

// 内容行删除之后, 清掉指向它们、还没有结论的审核任务与申诉 (已有结论的留作历史)。
// 两张表的 content_id 都没有外键, 级联删除带不走, 须用删除前收集的 id。
// 放在删除之后: 申诉提交会锁内容行, 这样并发提交的申诉不会成为孤儿。
// 评论通知不在这里清: 它要在评论行删除之前按行反推收件人, 见
// app/api/patch/comment/notifications.ts。整游戏的级联删除 (含删号时删掉其建档的游戏) 不清
// 评论通知, 那里留下的通知死链已裁定另案处理; 删号对其余评论走后台删除服务, 通知照常清
export const purgeContentDerivatives = async (
  tx: KunTx,
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

// 状态迁移之后内容还在, 指向它的在途审核任务怎么办:
//   cancel-keep-dry-run  管理员的裁决是最终的, 在途裁决不该再覆盖它 → 作废。dry_run
//                        任务只做评估、认领后从不改内容, 留着它的数据
//   keep                 迁移本身就是那条任务的裁决结果, 或内容此时不可能有在途任务
export type OpenTasksPolicy = 'cancel-keep-dry-run' | 'keep'

export const settleOpenTasks = async (
  tx: KunTx,
  kind: 'comment' | 'rating' | 'resource',
  ids: number[],
  policy: OpenTasksPolicy
) => {
  if (policy === 'cancel-keep-dry-run') {
    await deletePendingModerationTasks(kind, ids, tx, true)
  }
}
