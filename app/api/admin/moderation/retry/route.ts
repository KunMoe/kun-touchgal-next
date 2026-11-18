import { NextRequest, NextResponse } from 'next/server'
import { kunParsePutBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { prisma } from '~/prisma/index'
import { adminModerationRetrySchema } from '~/validations/admin'
import { requeueModerationTask } from '~/server/moderation/apply'
import { can } from '~/constants/permission'

export const PUT = async (req: NextRequest) => {
  const input = await kunParsePutBody(req, adminModerationRetrySchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const admin = await prisma.user.findUnique({ where: { id: payload.uid } })
  if (!admin) {
    return NextResponse.json('未找到该管理员')
  }

  const task = await prisma.moderation_task.findUnique({
    where: { id: input.taskId }
  })
  if (!task) {
    return NextResponse.json('未找到该审核任务')
  }
  if (task.status !== 'manual') {
    return NextResponse.json('仅转人工的任务可以重试')
  }
  // verdict 非空说明是 AI 拿不准 (m=1) 转人工, 内容已放行, 重跑无意义
  if (task.verdict !== null) {
    return NextResponse.json('该任务已有 AI 裁决, 请直接改判')
  }

  const res = await requeueModerationTask(task.id)
  if (res.count === 0) {
    return NextResponse.json('该任务已被处理, 请刷新后重试')
  }

  await prisma.admin_log.create({
    data: {
      type: 'update',
      user_id: payload.uid,
      content: `管理员 ${admin.name} 将审核任务 (ID: ${task.id}, 类型: ${task.content_type}, 用户 ID: ${task.user_id}) 重新加入审核队列`
    }
  })

  return NextResponse.json({})
}
