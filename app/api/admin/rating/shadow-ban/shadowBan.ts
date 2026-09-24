import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { recomputePatchRatingStat } from '~/app/api/patch/rating/stat'
import { adminUpdateRatingShadowBanSchema } from '~/validations/admin'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { invalidatePatchContentCacheByPatchId } from '~/app/api/patch/cache'

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
      patch_id: true,
      user: { select: { name: true } }
    }
  })
  if (!rating) {
    return '未找到该评价'
  }
  if (rating.status === status) {
    return `该评价已处于${statusLabel[status]}状态`
  }

  await prisma.$transaction(async (prisma) => {
    // 先作废在途审核任务再改 status: 锁顺序 (task→内容行) 与 worker apply 对齐,
    // 消除与 worker 的 AB-BA 死锁; 管理员裁决为最终, 在途裁决不应再覆盖.
    // (作者编辑路径锁序相反, 但非特权作者被 hasPendingModeration 挡在事务外)
    // 传 excludeDryRun=true: 内容仍在, 保留不改内容的 dry_run 评估任务
    await deletePendingModerationTasks('rating', ratingId, prisma, true)

    await prisma.patch_rating.update({
      where: { id: ratingId },
      data: { status }
    })

    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: adminUid,
        content: `管理员 ${admin.name} 将用户 ${rating.user.name} 的评价 (ID: ${ratingId}) 状态由 ${statusLabel[rating.status]} 修改为 ${statusLabel[status]}`
      }
    })

    await recomputePatchRatingStat(rating.patch_id, prisma)
  })

  // 事务提交后失效补丁详情缓存: ratingSummary 随评分统计变化 (M-05)
  await invalidatePatchContentCacheByPatchId(rating.patch_id).catch(
    () => undefined
  )

  return {}
}
