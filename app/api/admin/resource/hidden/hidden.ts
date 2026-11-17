import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { RESOURCE_STATUS } from '~/constants/contentStatus'
import { transitionResources } from '~/server/content/resource/transition'
import { adminUpdateResourceHiddenSchema } from '~/validations/admin'
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
  const from =
    status === RESOURCE_STATUS.hidden
      ? [RESOURCE_STATUS.public]
      : [RESOURCE_STATUS.hidden]

  return kunTx('admin.resource.hidden', async (ctx) => {
    // 管理员的裁决是最终的, 被迁移的资源上在途的审核任务一并作废 (dry_run 评估保留)。
    // 命令先锁资源行、只对锁下真正迁移的行作废任务: 与并发的作者编辑交错时, 不会
    // 留下「待审核却没有任何在途任务」的资源, 也不会谎报隐藏成功
    const moved = await transitionResources(ctx, resourceIds, {
      from,
      to: status,
      openTasks: 'cancel-keep-dry-run'
    })
    if (!moved.length) {
      return { count: 0 }
    }

    const movedIds = moved.map((row) => row.id)
    await ctx.tx.admin_log.create({
      data: {
        type: 'update',
        user_id: uid,
        content: truncateLogContent(
          `管理员 ${admin.name} 批量将 ${movedIds.length} 条资源状态修改为 ${statusLabel[status]}\n资源 ID: ${movedIds.join(', ')}`
        )
      }
    })

    return { count: movedIds.length }
  })
}
