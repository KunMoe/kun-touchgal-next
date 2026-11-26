import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { kunLog } from '~/lib/log.server'
import { adminModerationBatchSchema } from '~/validations/admin'
import {
  applyModerationVerdict,
  requeueModerationTask
} from '~/server/moderation/apply'

const actionLogLabelMap: Record<'approve' | 'reject' | 'retry', string> = {
  approve: '改判为通过',
  reject: '改判为拒绝',
  retry: '重新加入审核队列'
}

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminModerationBatchSchema,
  handler: async ({ input, actor }) => {
    const admin = await prisma.user.findUnique({ where: { id: actor.uid } })
    if (!admin) {
      return '未找到该管理员'
    }

    const taskIds = [...new Set(input.taskIds)]
    const tasks = await prisma.moderation_task.findMany({
      where: { id: { in: taskIds } }
    })
    const taskMap = new Map(tasks.map((task) => [task.id, task]))

    const succeededIds: number[] = []
    const failedIds: number[] = []

    // 逐条处理, 但客户端提交一个网络往返. 单条失败 (状态已变、S3 超时等)
    // 只计入 failedIds, 不影响同批其余任务
    for (const taskId of taskIds) {
      const task = taskMap.get(taskId)
      if (!task) {
        failedIds.push(taskId)
        continue
      }

      try {
        if (input.action === 'retry') {
          // verdict 非空为 AI 拿不准 (m=1) 转人工, 内容已放行, 重跑无意义
          if (task.status !== 'manual' || task.verdict !== null) {
            failedIds.push(taskId)
            continue
          }
          const res = await requeueModerationTask(task.id)
          if (res.count === 0) {
            failedIds.push(taskId)
          } else {
            succeededIds.push(taskId)
          }
          continue
        }

        if (task.status !== 'pending' && task.status !== 'manual') {
          failedIds.push(taskId)
          continue
        }
        const approve = input.action === 'approve'
        const applied = await applyModerationVerdict({
          task,
          approved: approve,
          rejectReason: approve ? undefined : '经人工复核为违规内容',
          model: 'admin',
          fromStatus: task.status as 'pending' | 'manual'
        })
        if (applied) {
          succeededIds.push(taskId)
        } else {
          failedIds.push(taskId)
        }
      } catch (error) {
        kunLog(
          'admin.batch_item_failed',
          { kind: 'moderation', action: input.action, id: taskId },
          error
        )
        failedIds.push(taskId)
      }
    }

    // 审计日志失败不遮蔽已生效的裁决: 内容已对用户生效, 绝不能因一行日志返回 500
    // 让管理员重试一整个已提交的批次
    if (succeededIds.length) {
      await prisma.admin_log
        .create({
          data: {
            type: 'update',
            user_id: actor.uid,
            content: `管理员 ${admin.name} 批量将 ${succeededIds.length} 个审核任务${actionLogLabelMap[input.action]}\n任务 ID: ${succeededIds.join(', ')}`
          }
        })
        .catch((error) =>
          kunLog('admin.log_write_failed', { action: input.action }, error)
        )
    }

    return { success: succeededIds.length, failedIds }
  }
})
