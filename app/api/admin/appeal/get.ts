import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminAppealPaginationSchema } from '~/validations/admin'
import type { AdminAppealItem, AppealPayload } from '~/types/api/appeal'

export const getAppeals = async (
  input: z.infer<typeof adminAppealPaginationSchema>
) => {
  const { page, limit, status } = input
  const offset = (page - 1) * limit
  const where = status === 'all' ? {} : { status }

  const [data, total] = await Promise.all([
    prisma.moderation_appeal.findMany({
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
        },
        task: { select: { reject_reason: true } }
      }
    }),
    prisma.moderation_appeal.count({ where })
  ])

  const idsOf = (type: string) =>
    data
      .filter((appeal) => appeal.content_type === type)
      .map((appeal) => appeal.content_id)

  const patchSelect = { select: { name: true, unique_id: true } }
  const [comments, ratings, resources] = await Promise.all([
    prisma.patch_comment.findMany({
      where: { id: { in: idsOf('comment') } },
      select: { id: true, content: true, resource_id: true, patch: patchSelect }
    }),
    prisma.patch_rating.findMany({
      where: { id: { in: idsOf('rating') } },
      select: { id: true, short_summary: true, patch: patchSelect }
    }),
    prisma.patch_resource.findMany({
      where: { id: { in: idsOf('resource') } },
      select: { id: true, name: true, note: true, patch: patchSelect }
    })
  ])

  const originalMap = new Map<string, AppealPayload>()
  const patchMap = new Map<string, { uniqueId: string; name: string }>()
  const commentResourceMap = new Map<number, number | null>()
  for (const comment of comments) {
    originalMap.set(`comment:${comment.id}`, { text: comment.content })
    patchMap.set(`comment:${comment.id}`, {
      uniqueId: comment.patch.unique_id,
      name: comment.patch.name
    })
    commentResourceMap.set(comment.id, comment.resource_id)
  }
  for (const rating of ratings) {
    originalMap.set(`rating:${rating.id}`, { text: rating.short_summary })
    patchMap.set(`rating:${rating.id}`, {
      uniqueId: rating.patch.unique_id,
      name: rating.patch.name
    })
  }
  for (const resource of resources) {
    originalMap.set(`resource:${resource.id}`, {
      name: resource.name,
      note: resource.note
    })
    patchMap.set(`resource:${resource.id}`, {
      uniqueId: resource.patch.unique_id,
      name: resource.patch.name
    })
  }

  const appeals: AdminAppealItem[] = data.map((appeal) => ({
    id: appeal.id,
    contentType: appeal.content_type,
    contentId: appeal.content_id,
    status: appeal.status,
    payload: appeal.payload as AppealPayload,
    original:
      originalMap.get(`${appeal.content_type}:${appeal.content_id}`) ?? null,
    rejectReason: appeal.task.reject_reason,
    commentResourceId:
      appeal.content_type === 'comment'
        ? (commentResourceMap.get(appeal.content_id) ?? null)
        : null,
    patch: patchMap.get(`${appeal.content_type}:${appeal.content_id}`) ?? null,
    user: appeal.user,
    created: appeal.created,
    updated: appeal.updated
  }))

  return { appeals, total }
}
