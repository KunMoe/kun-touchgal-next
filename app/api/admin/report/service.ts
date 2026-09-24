import * as z from 'zod'
import { convert } from 'html-to-text'
import { prisma } from '~/prisma/index'
import { adminReportPaginationSchema } from '~/validations/admin'
import type { AdminReport, AdminReportTargetType } from '~/types/api/admin'

export const getReport = async (
  input: z.infer<typeof adminReportPaginationSchema>
) => {
  const { page, limit, tab, targetType } = input
  const offset = (page - 1) * limit

  const where = {
    target_type: targetType,
    ...(tab === 'pending' ? { status: 0 } : { status: { in: [2, 3] } })
  }

  const [data, total] = await Promise.all([
    prisma.patch_report.findMany({
      where,
      include: {
        sender: {
          select: { id: true, name: true, avatar: true }
        },
        reported_user: {
          select: { id: true, name: true, avatar: true }
        },
        handler: {
          select: { id: true, name: true, avatar: true }
        },
        patch: {
          select: { id: true, unique_id: true, name: true }
        },
        comment: {
          select: { id: true, content: true, resource_id: true }
        },
        rating: {
          select: {
            id: true,
            short_summary: true,
            overall: true,
            recommend: true,
            play_status: true
          }
        }
      },
      orderBy: { created: 'desc' },
      skip: offset,
      take: limit
    }),
    prisma.patch_report.count({ where })
  ])

  const reports: AdminReport[] = data.map((report) => ({
    id: report.id,
    targetType: report.target_type as AdminReportTargetType,
    status: report.status,
    reason: report.reason,
    handlerReply: report.handler_reply,
    handledAt: report.handled_at,
    created: report.created,
    sender: report.sender,
    reportedUser: report.reported_user,
    handler: report.handler,
    patch: {
      id: report.patch.id,
      uniqueId: report.patch.unique_id,
      name: report.patch.name
    },
    comment: report.comment
      ? {
          id: report.comment.id,
          contentPreview: convert(report.comment.content).trim().slice(0, 300),
          resourceId: report.comment.resource_id
        }
      : null,
    rating: report.rating
      ? {
          id: report.rating.id,
          shortSummary: report.rating.short_summary,
          overall: report.rating.overall,
          recommend: report.rating.recommend,
          playStatus: report.rating.play_status
        }
      : null
  }))

  return { reports, total }
}
