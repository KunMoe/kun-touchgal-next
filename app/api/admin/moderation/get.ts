import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminModerationPaginationSchema } from '~/validations/admin'
import {
  MODERATION_PAYLOAD_UNREADABLE,
  decodeModerationTask
} from '~/server/moderation/taskCodec'
import type { AdminModerationTask } from '~/types/api/admin'

// 管理端只需要展示用的几个字段; 解不出来的任务渲染占位, 不让整页失败
const toAdminPayload = (task: {
  content_type: string
  payload: unknown
}): AdminModerationTask['payload'] => {
  const body = decodeModerationTask(task)
  if (!body) {
    return { text: `(${MODERATION_PAYLOAD_UNREADABLE})` }
  }
  if (body.contentType === 'avatar') {
    return {
      pendingLink: body.payload.pendingLink,
      archiveLink: body.payload.archiveLink
    }
  }
  return { text: body.text, name: body.name, bio: body.bio }
}

export const getModerationTasks = async (
  input: z.infer<typeof adminModerationPaginationSchema>
) => {
  const { page, limit, status } = input
  const offset = (page - 1) * limit
  const where = status === 'all' ? {} : { status }

  const [data, total] = await Promise.all([
    prisma.moderation_task.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { created: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        }
      }
    }),
    prisma.moderation_task.count({ where })
  ])

  // rating / resource 任务创建时写入 patch_id; comment 任务无 patch_id, 经 patch_comment 反查
  const patchIds = data.flatMap((task) =>
    task.patch_id !== null ? [task.patch_id] : []
  )
  const commentIds = data.flatMap((task) =>
    task.content_type === 'comment' && task.content_id !== null
      ? [task.content_id]
      : []
  )
  const [patches, comments] = await Promise.all([
    patchIds.length
      ? prisma.patch.findMany({
          where: { id: { in: patchIds } },
          select: { id: true, name: true, unique_id: true }
        })
      : [],
    commentIds.length
      ? prisma.patch_comment.findMany({
          where: { id: { in: commentIds } },
          select: {
            id: true,
            resource_id: true,
            patch: { select: { name: true, unique_id: true } }
          }
        })
      : []
  ])
  const patchMap = new Map(
    patches.map((p) => [p.id, { uniqueId: p.unique_id, name: p.name }])
  )
  const commentPatchMap = new Map(
    comments.map((c) => [
      c.id,
      { uniqueId: c.patch.unique_id, name: c.patch.name }
    ])
  )
  const commentResourceMap = new Map(comments.map((c) => [c.id, c.resource_id]))

  const resolvePatch = (task: (typeof data)[number]) => {
    if (task.patch_id !== null) {
      return patchMap.get(task.patch_id) ?? null
    }
    if (task.content_type === 'comment' && task.content_id !== null) {
      return commentPatchMap.get(task.content_id) ?? null
    }
    return null
  }

  const tasks: AdminModerationTask[] = data.map((task) => ({
    id: task.id,
    contentType: task.content_type,
    contentId: task.content_id,
    status: task.status,
    rejectCode: task.reject_code,
    rejectReason: task.reject_reason,
    payload: toAdminPayload(task),
    verdict: task.verdict,
    model: task.model,
    tokensIn: task.tokens_in,
    tokensOut: task.tokens_out,
    retry: task.retry,
    dryRun: task.dry_run,
    user: task.user,
    commentResourceId:
      task.content_type === 'comment' && task.content_id !== null
        ? (commentResourceMap.get(task.content_id) ?? null)
        : null,
    patch: resolvePatch(task),
    created: task.created,
    reviewed: task.reviewed
  }))

  return { tasks, total }
}
