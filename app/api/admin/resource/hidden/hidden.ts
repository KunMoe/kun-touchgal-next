import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { RESOURCE_STATUS, contentStatusLabel } from '~/constants/contentStatus'
import { transitionResources } from '~/server/content/resource/transition'
import { adminUpdateResourceHiddenSchema } from '~/validations/admin'
import { truncateLogContent } from '~/app/api/admin/_log'
import { RESOURCE_TRANSITIONS } from '~/utils/content/transitions'

export const updateResourceHidden = async (
  input: z.infer<typeof adminUpdateResourceHiddenSchema>,
  uid: number
) => {
  const admin = await prisma.user.findUnique({ where: { id: uid } })
  if (!admin) {
    return '未找到该管理员'
  }

  const { resourceIds, status } = input
  // 只在公开与隐藏之间迁移, 待初审 / 待审是系统态, 不被命中 (utils/content/transitions.ts)
  const transition =
    RESOURCE_TRANSITIONS[status === RESOURCE_STATUS.hidden ? 'hide' : 'unhide']

  // 与后台批删等入口在行锁上互等时数据库会判死锁回滚其中一方, 事务整体回滚、无副作用,
  // 重放即可
  return kunTx(
    'admin.resource.hidden',
    async (ctx) => {
      // 管理员的裁决是最终的, 被迁移的资源上在途的审核任务一并作废 (dry_run 评估保留)。
      // 命令先锁资源行、只对锁下真正迁移的行作废任务: 与并发的作者编辑交错时, 不会
      // 留下「待审核却没有任何在途任务」的资源, 也不会谎报隐藏成功
      const moved = await transitionResources(ctx, resourceIds, {
        ...transition,
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
            `管理员 ${admin.name} 批量将 ${movedIds.length} 条资源状态修改为 ${contentStatusLabel('resource', status)}\n资源 ID: ${movedIds.join(', ')}`
          )
        }
      })

      return { count: movedIds.length }
    },
    { retry: 2 }
  )
}
