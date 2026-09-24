import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { recalcPatchType } from '~/app/api/patch/resource/_helper'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import {
  enqueueSearchOutbox,
  kickSearchOutboxDrain
} from '~/server/search/sync'
import { adminUpdateResourceHiddenSchema } from '~/validations/admin'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { truncateLogContent } from '~/app/api/admin/_log'

const statusLabel: Record<number, string> = {
  0: '正常',
  1: '隐藏'
}

export const updateResourceHidden = async (
  input: z.infer<typeof adminUpdateResourceHiddenSchema>,
  uid: number
) => {
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const { resourceIds, status } = input
  // 仅在 0 (正常) / 1 (隐藏) 之间流转; 待初次审核 (2) / 待审核 (3) 为系统态, 永不被命中
  const fromStatuses = [0, 1].filter((value) => value !== status)

  const targets = await prisma.patch_resource.findMany({
    where: { id: { in: resourceIds }, status: { in: fromStatuses } },
    select: { id: true, patch_id: true }
  })
  if (!targets.length) {
    return { count: 0 }
  }

  const targetIds = targets.map((resource) => resource.id)
  // 排序后再逐个加通告锁 (recalcPatchType 内): 确定性锁序, 消除两个反序重叠批在
  // patch 级通告锁上的 AB-BA 死锁 (与上面 task→资源行的锁序处理同理)
  const patchIds = [
    ...new Set(targets.map((resource) => resource.patch_id))
  ].sort((a, b) => a - b)

  const affectedUniqueIds: string[] = []
  await prisma.$transaction(async (prisma) => {
    // 先作废在途审核任务再改 status: 锁顺序 (task→资源行) 与 worker apply 对齐,
    // 消除与 worker 的 AB-BA 死锁; 管理员裁决为最终, 在途裁决不应再覆盖.
    // (作者编辑路径锁序相反, 但非特权作者被 hasPendingModeration 挡在事务外,
    // 且编辑事务在行锁下复检 status, 隐藏提交后的编辑必然被拒)
    // 传 excludeDryRun=true: 资源仍在, 保留不改内容的 dry_run 评估任务
    await deletePendingModerationTasks('resource', targetIds, prisma, true)

    await prisma.patch_resource.updateMany({
      where: { id: { in: targetIds }, status: { in: fromStatuses } },
      data: { status }
    })

    // 资源可见性改变, 重算受影响补丁的 type/language/platform 聚合标签
    // 与 create/update/delete/approve 等既有流程保持一致
    // 事务性入队与重算同循环：与补丁变更原子提交，关闭崩溃丢失窗口
    for (const patchId of patchIds) {
      affectedUniqueIds.push(await recalcPatchType(patchId, prisma))
      await enqueueSearchOutbox(prisma, patchId)
    }

    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: uid,
        content: truncateLogContent(
          `管理员 ${admin.name} 批量将 ${targetIds.length} 条资源状态修改为 ${statusLabel[status]}\n资源 ID: ${targetIds.join(', ')}`
        )
      }
    })
  })

  // 事务内已逐 id 入队，此处一次 kick 触发 drain 处理整箱（避免逐 id 各 kick）
  kickSearchOutboxDrain()

  // 事务提交后失效: 事务内失效会被并发读回填旧值 (M-04), 且 Redis 故障不应回滚写入
  await Promise.all(
    affectedUniqueIds.map((uniqueId) =>
      invalidatePatchContentCache(uniqueId).catch(() => undefined)
    )
  )

  await Promise.all(
    patchIds.map((patchId) => invalidatePatchResourceDetailCache(patchId))
  )
  await invalidateResourceListCache()

  return { count: targetIds.length }
}
