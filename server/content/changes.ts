import { COMMENT_STATUS } from '~/constants/contentStatus'
import { recordKunChanges } from '~/server/cache/publish'
import { onCommentPublished } from '~/server/content/comment/publish'
import type { KunChange } from '~/server/cache/changes'
import type { KunTxContext } from '~/server/db/tx'

// 一行内容在一次事务里实际发生的变化; before / after 为 null 表示行此前不存在 / 已删除。
// 只描述锁下真正迁移或删除的行, 不是入口打算改的行
export type ContentChange = Extract<
  KunChange,
  { kind: 'comment' | 'rating' | 'resource' }
>

// 内容命令登记提交后副作用的入口。要失效哪些共享缓存由 server/cache/plan.ts 按前后状态推导;
// 这里另外只管一件事: 评论由非公开变为公开时, 登记一次通知补发 (创建时被审核拦截而没发的
// 那些), 排在全部缓存失效之后。
// 资源变化引起的补丁聚合 (type / language / platform) 失效跟随 recalcPatchType, 由执行
// 重算的命令自己报告 patch 变更, 不在这里
export const recordContentChanges = (
  ctx: Pick<KunTxContext, 'afterCommit'>,
  changes: ContentChange[]
) => {
  recordKunChanges(ctx, changes)
  for (const change of changes) {
    if (
      change.kind === 'comment' &&
      change.before !== COMMENT_STATUS.public &&
      change.after === COMMENT_STATUS.public
    ) {
      ctx.afterCommit(`commentPublished:${change.id}`, () =>
        onCommentPublished(change.id)
      )
    }
  }
}
