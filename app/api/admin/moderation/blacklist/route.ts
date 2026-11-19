import { kunRoute } from '~/app/api/utils/kunRoute'
import { formatModerationContentTypeLabel } from '~/constants/moderation'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import {
  adminModerationBlacklistCreateSchema,
  adminModerationBlacklistDeleteSchema
} from '~/validations/admin'
import type { AdminModerationBlacklistItem } from '~/types/api/admin'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  handler: async () => {
    const data = await prisma.moderation_blacklist.findMany({
      orderBy: { created: 'desc' },
      include: {
        user: {
          select: { id: true, name: true, avatar: true }
        }
      }
    })

    const items: AdminModerationBlacklistItem[] = data.map((item) => ({
      id: item.id,
      pattern: item.pattern,
      contentTypes: item.content_types,
      user: item.user,
      created: item.created
    }))

    return { items }
  }
})

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'admin.access',
  input: adminModerationBlacklistCreateSchema,
  handler: async ({ input, actor }) => {
    const duplicated = await prisma.moderation_blacklist.findFirst({
      where: { pattern: input.pattern }
    })
    if (duplicated) {
      return '该模式已在黑名单中'
    }

    const typeLabel = formatModerationContentTypeLabel(input.contentTypes)
    const failure = await kunTx(
      'admin.moderation.blacklist.create',
      async ({ tx }) => {
        await tx.moderation_blacklist.create({
          data: {
            pattern: input.pattern,
            content_types: input.contentTypes,
            user_id: actor.uid
          }
        })
        await tx.admin_log.create({
          data: {
            type: 'create',
            user_id: actor.uid,
            content: `管理员添加了审核黑名单模式: ${input.pattern} (生效类型: ${typeLabel})`
          }
        })
      }
    )

    return failure ?? {}
  }
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  capability: 'admin.access',
  input: adminModerationBlacklistDeleteSchema,
  handler: async ({ input, actor }) => {
    const item = await prisma.moderation_blacklist.findUnique({
      where: { id: input.blacklistId }
    })
    if (!item) {
      return '未找到该黑名单模式'
    }

    const failure = await kunTx(
      'admin.moderation.blacklist.delete',
      async ({ tx }) => {
        await tx.moderation_blacklist.delete({ where: { id: item.id } })
        await tx.admin_log.create({
          data: {
            type: 'delete',
            user_id: actor.uid,
            content: `管理员删除了审核黑名单模式: ${item.pattern}`
          }
        })
      }
    )

    return failure ?? {}
  }
})
