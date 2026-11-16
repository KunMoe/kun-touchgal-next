import * as z from 'zod'
import { prisma } from '~/prisma/index'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { getUserAppealSchema } from '~/validations/appeal'
import { APPEAL_CONTENT_TYPE } from '~/constants/appeal'
import {
  APPEAL_LINK_SELECT,
  getAppealModelName
} from '~/server/moderation/appeal'
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

// 该用户全部可申诉任务的 id。可申诉 = 尚未申诉 + 内容仍处于被隐藏的状态 + 是该内容
// 最新的一条被拒任务, 须与下方逐条推导 state 的规则保持一致。内容经 content_type +
// content_id 多态引用, 没有外键, Prisma 的 where 表达不了这个条件, 所以按状态筛选时
// 先用 SQL 取出 id, 再交给 where 分页与计数
const findAppealableTaskIds = async (uid: number) => {
  const rows = await prisma.$queryRaw<{ id: number }[]>`
    SELECT t.id
    FROM moderation_task t
    WHERE t.user_id = ${uid}
      AND t.status = 'rejected'
      AND t.dry_run = false
      AND NOT EXISTS (
        SELECT 1 FROM moderation_appeal a WHERE a.task_id = t.id
      )
      AND CASE t.content_type
        WHEN 'comment' THEN EXISTS (
          SELECT 1 FROM patch_comment c
          WHERE c.id = t.content_id AND c.status = 2
        )
        WHEN 'rating' THEN EXISTS (
          SELECT 1 FROM patch_rating r
          WHERE r.id = t.content_id AND r.status = 2
        )
        WHEN 'resource' THEN EXISTS (
          SELECT 1 FROM patch_resource r
          WHERE r.id = t.content_id AND r.status = 1
        )
        ELSE false
      END
      AND NOT EXISTS (
        SELECT 1 FROM moderation_task newer
        WHERE newer.content_type = t.content_type
          AND newer.content_id = t.content_id
          AND newer.status = 'rejected'
          AND newer.dry_run = false
          AND newer.id > t.id
      )
  `
  return rows.map((row) => row.id)
}

// 以被拒的审核任务驱动列表, 申诉处理后仍可作为历史记录展示
export const getUserAppeals = async (
  uid: number,
  input: z.infer<typeof getUserAppealSchema>
) => {
  const { page, limit, state } = input
  const offset = (page - 1) * limit

  let stateWhere: Prisma.moderation_taskWhereInput = {}
  if (state === 'appealable' || state === 'unavailable') {
    const appealableIds = await findAppealableTaskIds(uid)
    stateWhere =
      state === 'appealable'
        ? { id: { in: appealableIds } }
        : { appeal: null, id: { notIn: appealableIds } }
  } else if (state !== 'all') {
    stateWhere = { appeal: { status: state } }
  }

  const where = {
    user_id: uid,
    status: 'rejected',
    dry_run: false,
    content_type: { in: [...APPEAL_CONTENT_TYPE] },
    content_id: { not: null },
    ...stateWhere
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
        type: true,
        model_name: true,
        status: true,
        links: { orderBy: { sort_order: 'asc' }, select: APPEAL_LINK_SELECT },
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
      original: {
        name: resource.name,
        note: resource.note,
        modelName: getAppealModelName(resource),
        links: resource.links
      }
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
