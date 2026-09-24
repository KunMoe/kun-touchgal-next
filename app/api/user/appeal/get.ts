import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { getUserAppealSchema } from '~/validations/appeal'
import { APPEAL_CONTENT_TYPE } from '~/constants/appeal'
import type {
  AppealPayload,
  UserAppealItem,
  UserAppealState
} from '~/types/api/appeal'

interface ContentInfo {
  hidden: boolean
  patchName: string
  original: AppealPayload
}

// 以被拒的审核任务驱动列表, 申诉处理后仍可作为历史记录展示
export const getUserAppeals = async (
  uid: number,
  input: z.infer<typeof getUserAppealSchema>
) => {
  const { page, limit } = input
  const offset = (page - 1) * limit
  const where = {
    user_id: uid,
    status: 'rejected',
    dry_run: false,
    content_type: { in: [...APPEAL_CONTENT_TYPE] },
    content_id: { not: null }
  }

  const [tasks, total] = await Promise.all([
    prisma.moderation_task.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { created: 'desc' },
      include: { appeal: true }
    }),
    prisma.moderation_task.count({ where })
  ])

  const idsOf = (type: string) =>
    tasks
      .filter((task) => task.content_type === type)
      .map((task) => task.content_id ?? 0)

  const [comments, ratings, resources, latestTasks] = await Promise.all([
    prisma.patch_comment.findMany({
      where: { id: { in: idsOf('comment') } },
      select: {
        id: true,
        content: true,
        status: true,
        patch: { select: { name: true } }
      }
    }),
    prisma.patch_rating.findMany({
      where: { id: { in: idsOf('rating') } },
      select: {
        id: true,
        short_summary: true,
        status: true,
        patch: { select: { name: true } }
      }
    }),
    prisma.patch_resource.findMany({
      where: { id: { in: idsOf('resource') } },
      select: {
        id: true,
        name: true,
        note: true,
        status: true,
        patch: { select: { name: true } }
      }
    }),
    // 同一内容可能存在多条被拒任务 (如管理员恢复后再次被拒),
    // 仅最新一条可申诉, 旧任务标记为已失效
    prisma.moderation_task.groupBy({
      by: ['content_type', 'content_id'],
      where: {
        status: 'rejected',
        dry_run: false,
        OR: APPEAL_CONTENT_TYPE.map((type) => ({
          content_type: type,
          content_id: { in: idsOf(type) }
        }))
      },
      _max: { id: true }
    })
  ])

  const contentMap = new Map<string, ContentInfo>()
  for (const comment of comments) {
    contentMap.set(`comment:${comment.id}`, {
      hidden: comment.status === 2,
      patchName: comment.patch.name,
      original: { text: comment.content }
    })
  }
  for (const rating of ratings) {
    contentMap.set(`rating:${rating.id}`, {
      hidden: rating.status === 2,
      patchName: rating.patch.name,
      original: { text: rating.short_summary }
    })
  }
  for (const resource of resources) {
    contentMap.set(`resource:${resource.id}`, {
      hidden: resource.status === 1,
      patchName: resource.patch.name,
      original: { name: resource.name, note: resource.note }
    })
  }

  const latestTaskIds = new Set(latestTasks.map((group) => group._max.id))

  const appeals: UserAppealItem[] = tasks.map((task) => {
    const content = contentMap.get(`${task.content_type}:${task.content_id}`)

    let state: UserAppealState
    if (task.appeal) {
      state = task.appeal.status as UserAppealState
    } else if (content?.hidden && latestTaskIds.has(task.id)) {
      state = 'appealable'
    } else {
      state = 'unavailable'
    }

    return {
      taskId: task.id,
      contentType: task.content_type,
      contentId: task.content_id ?? 0,
      rejectCode: task.reject_code,
      rejectedAt: task.reviewed,
      patchName: content?.patchName ?? null,
      original: content?.original ?? null,
      state,
      appeal: task.appeal
        ? {
            id: task.appeal.id,
            status: task.appeal.status,
            payload: task.appeal.payload as AppealPayload,
            updated: task.appeal.updated
          }
        : null
    }
  })

  return { appeals, total }
}
