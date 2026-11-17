import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { RATING_STATUS } from '~/constants/contentStatus'
import { transitionRatings } from '~/server/content/rating/transition'
import { adminUpdateRatingShadowBanSchema } from '~/validations/admin'

const statusLabel: Record<number, string> = {
  0: '正常',
  1: '待审核',
  2: '隐藏'
}

export const updateRatingShadowBan = async (
  input: z.infer<typeof adminUpdateRatingShadowBanSchema>,
  adminUid: number
) => {
  const admin = await prisma.user.findUnique({ where: { id: adminUid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const { ratingId, status } = input

  const rating = await prisma.patch_rating.findUnique({
    where: { id: ratingId },
    select: {
      id: true,
      status: true,
      user: { select: { name: true } }
    }
  })
  if (!rating) {
    return '未找到该评价'
  }
  if (rating.status === status) {
    return `该评价已处于${statusLabel[status]}状态`
  }

  return kunTx('admin.rating.shadowBan', async (ctx) => {
    // 管理员的裁决是最终的, 在途的审核任务一并作废 (dry_run 评估保留)。评分统计由
    // 命令在同一事务里重算
    const [moved] = await transitionRatings(ctx, [ratingId], {
      from: Object.values(RATING_STATUS).filter((value) => value !== status),
      to: status,
      openTasks: 'cancel-keep-dry-run'
    })
    // 上面判的是事务外快照; 行锁下已是目标状态, 或已被删除
    if (!moved) {
      const exists = await ctx.tx.patch_rating.findUnique({
        where: { id: ratingId },
        select: { id: true }
      })
      return ctx.fail(
        exists ? `该评价已处于${statusLabel[status]}状态` : '未找到该评价'
      )
    }

    await ctx.tx.admin_log.create({
      data: {
        type: 'update',
        user_id: adminUid,
        content: `管理员 ${admin.name} 将用户 ${rating.user.name} 的评价 (ID: ${ratingId}) 状态由 ${statusLabel[moved.from]} 修改为 ${statusLabel[status]}`
      }
    })
    return {}
  })
}
