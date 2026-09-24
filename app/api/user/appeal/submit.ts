import * as z from 'zod'
import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { submitAppealSchema } from '~/validations/appeal'
import type { AppealPayload } from '~/types/api/appeal'

// 校验申诉目标内容仍归属本人且处于隐藏状态
const checkContentAppealable = async (
  contentType: string,
  contentId: number,
  uid: number
) => {
  if (contentType === 'comment') {
    const comment = await prisma.patch_comment.findUnique({
      where: { id: contentId },
      select: { user_id: true, status: true }
    })
    return !!comment && comment.user_id === uid && comment.status === 2
  }
  if (contentType === 'rating') {
    const rating = await prisma.patch_rating.findUnique({
      where: { id: contentId },
      select: { user_id: true, status: true }
    })
    return !!rating && rating.user_id === uid && rating.status === 2
  }
  const resource = await prisma.patch_resource.findUnique({
    where: { id: contentId },
    select: { user_id: true, status: true }
  })
  return !!resource && resource.user_id === uid && resource.status === 1
}

// 事务内业务失败, 回滚后把错误消息返回给调用方
class SubmitAppealError extends Error {}

// 用 FOR UPDATE 锁定目标内容行, 与并发的内容删除在该行上互斥;
// 返回 false 表示内容已被删除或状态已变更 (不再是可申诉的隐藏态)
const lockContentForAppeal = async (
  contentType: string,
  contentId: number,
  uid: number,
  tx: Prisma.TransactionClient
) => {
  if (contentType === 'comment') {
    const rows = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM patch_comment
      WHERE id = ${contentId} AND user_id = ${uid} AND status = 2
      FOR UPDATE
    `
    return rows.length > 0
  }
  if (contentType === 'rating') {
    const rows = await tx.$queryRaw<{ id: number }[]>`
      SELECT id FROM patch_rating
      WHERE id = ${contentId} AND user_id = ${uid} AND status = 2
      FOR UPDATE
    `
    return rows.length > 0
  }
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT id FROM patch_resource
    WHERE id = ${contentId} AND user_id = ${uid} AND status = 1
    FOR UPDATE
  `
  return rows.length > 0
}

export const submitAppeal = async (
  input: z.infer<typeof submitAppealSchema>,
  uid: number
) => {
  const task = await prisma.moderation_task.findUnique({
    where: { id: input.taskId },
    include: { appeal: true }
  })
  if (!task || task.user_id !== uid) {
    return '未找到该审核记录'
  }
  if (
    task.status !== 'rejected' ||
    task.dry_run ||
    !task.content_id ||
    task.content_type !== input.contentType
  ) {
    return '该审核记录不可申诉'
  }
  // 申诉只能提交一次, 提交后 payload 锁定不可修改: 避免用户在管理员复核过程中
  // 把已展示给管理员的无害内容换成违规内容 (申诉通过不再走 AI 复审)
  if (task.appeal) {
    return '您已提交过申诉, 无法重复提交'
  }

  const contentId = task.content_id
  if (!(await checkContentAppealable(input.contentType, contentId, uid))) {
    return '内容不存在或状态已变更, 无法申诉'
  }

  // 同一内容可能有多条被拒任务 (管理员恢复后再次被拒), 只允许在最新一条上申诉,
  // 防止同一内容产生多个待处理申诉
  const newerTask = await prisma.moderation_task.findFirst({
    where: {
      content_type: input.contentType,
      content_id: contentId,
      status: 'rejected',
      dry_run: false,
      id: { gt: task.id }
    },
    select: { id: true }
  })
  if (newerTask) {
    return '该审核记录已失效, 请在最新的拒绝记录上申诉'
  }
  const otherPendingAppeal = await prisma.moderation_appeal.findFirst({
    where: {
      content_type: input.contentType,
      content_id: contentId,
      status: 'pending',
      task_id: { not: task.id }
    },
    select: { id: true }
  })
  if (otherPendingAppeal) {
    return '该内容已有待处理的申诉'
  }

  const payload: AppealPayload =
    input.contentType === 'resource'
      ? { name: input.name, note: input.note }
      : {
          text:
            input.contentType === 'comment' ? input.content : input.shortSummary
        }

  // 事务内先 FOR UPDATE 锁内容行再重校验存活, 与并发的内容删除互斥:
  // 删除先提交则此处锁到时内容已消失而拒绝; 本事务先提交则删除方在删内容后清理掉本申诉,
  // 两个方向都不会残留孤儿 pending 申诉 (task_id 唯一约束仍兜底并发重复提交)
  try {
    await prisma.$transaction(async (tx) => {
      if (
        !(await lockContentForAppeal(input.contentType, contentId, uid, tx))
      ) {
        throw new SubmitAppealError('内容不存在或状态已变更, 无法申诉')
      }
      await tx.moderation_appeal.create({
        data: {
          content_type: input.contentType,
          content_id: contentId,
          task_id: task.id,
          user_id: uid,
          payload: payload as unknown as Prisma.InputJsonValue
        }
      })
    })
  } catch (error) {
    if (error instanceof SubmitAppealError) {
      return error.message
    }
    throw error
  }

  return {}
}
