import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { adminModerationRetrySchema } from '~/validations/admin'
import { requeueModerationTask } from '~/server/moderation/apply'

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminModerationRetrySchema,
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
    if (task.status !== 'manual') {
      return '仅转人工的任务可以重试'
    }
    // verdict 非空说明是 AI 拿不准 (m=1) 转人工, 内容已放行, 重跑无意义
    if (task.verdict !== null) {
      return '该任务已有 AI 裁决, 请直接改判'
    }

    const res = await requeueModerationTask(task.id)
    if (res.count === 0) {
      return '该任务已被处理, 请刷新后重试'
    }

    await prisma.admin_log.create({
      data: {
        type: 'update',
        user_id: actor.uid,
        content: `管理员 ${admin.name} 将审核任务 (ID: ${task.id}, 类型: ${task.content_type}, 用户 ID: ${task.user_id}) 重新加入审核队列`
      }
    })

    return {}
  }
})
