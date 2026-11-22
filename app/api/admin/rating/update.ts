import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { patchRatingUpdateSchema } from '~/validations/admin'
import { planTextModeration } from '~/server/moderation/submit'
import { ratingSubject } from '~/server/moderation/subject'
import { kunTx } from '~/server/db/tx'
import { editRating } from '~/server/content/rating/edit'
import type { KunActor } from '~/constants/role'

export const updateRating = async (
  input: z.infer<typeof patchRatingUpdateSchema>,
  actor: KunActor
) => {
  const { uid } = actor
  const rating = await prisma.patch_rating.findUnique({
    where: { id: input.ratingId }
  })
  if (!rating) {
    return '未找到对应的评价'
  }
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  // 送审与否只由操作者的真实角色决定 (超级管理员豁免), 后台入口不另开口子
  const moderation = await planTextModeration(
    ratingSubject(input.shortSummary),
    { actor, previous: ratingSubject(rating.short_summary) }
  )
  if (typeof moderation === 'string') {
    return moderation
  }

  // 后台编辑不设守卫: 隐藏、待审的评价都能改; 也不作废在途的审核任务
  const failure = await kunTx('admin.rating.update', async (ctx) => {
    const { row } = await editRating(ctx, input.ratingId, {
      data: { short_summary: input.shortSummary },
      moderation
    })
    if (!row) {
      ctx.fail('未找到对应的评价')
    }

    await ctx.tx.admin_log.create({
      data: {
        type: 'update',
        user_id: uid,
        content: `管理员 ${admin.name} 更新了一条评价的简评\n原评价: ${JSON.stringify(rating)}`
      }
    })
  })
  return failure ?? {}
}
