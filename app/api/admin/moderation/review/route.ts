import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { adminModerationReviewSchema } from '~/validations/admin'
import { applyModerationVerdict } from '~/server/moderation/apply'
import { MODERATION_TASK_STATUS_MAP } from '~/constants/moderation'

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminModerationReviewSchema,
  handler: async ({ input, actor }) => {
    const admin = await prisma.user.findUnique({ where: { id: actor.uid } })
    if (!admin) {
      return '未找到该管理员'
    }

    const task = await prisma.moderation_task.findUnique({
      where: { id: input.taskId }
    })
    if (!task) {
      return '未找到该审核任务'
    }
    if (task.status !== 'pending' && task.status !== 'manual') {
      return `仅待审核或转人工的任务可以改判, 当前状态为 ${MODERATION_TASK_STATUS_MAP[task.status] ?? task.status}`
    }

    const applied = await applyModerationVerdict({
      task,
      approved: input.approve,
      rejectReason: input.approve ? undefined : '经人工复核为违规内容',
      model: 'admin',
      fromStatus: task.status as 'pending' | 'manual'
    })
    if (!applied) {
      return '该任务已被处理, 请刷新后重试'
    }

    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: actor.uid,
        content: `管理员 ${admin.name} 将审核任务 (ID: ${task.id}, 类型: ${task.content_type}, 用户 ID: ${task.user_id}) 改判为${input.approve ? '通过' : '拒绝'}`
      }
    })

    return {}
  }
})
