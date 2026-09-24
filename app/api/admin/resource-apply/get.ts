import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { adminResourceApplyPaginationSchema } from '~/validations/admin'
import { markdownToHtml } from '~/app/api/utils/render/markdownToHtml'
import type { AdminResource } from '~/types/api/admin'

export const getPatchResourceApply = async (
  input: z.infer<typeof adminResourceApplyPaginationSchema>,
  nsfwEnable: Record<string, string | undefined>
) => {
  const { page, limit, search } = input
  const offset = (page - 1) * limit

  const whereBase = {
    patch: nsfwEnable,
    status: 2
  } as const

  const where = search
    ? {
        ...whereBase,
        links: {
          some: {
            OR: [
              {
                content: {
                  contains: search,
                  mode: 'insensitive' as const
                }
              },
              {
                hash: {
                  contains: search,
                  mode: 'insensitive' as const
                }
              }
            ]
          }
        }
      }
    : whereBase

  const [data, total] = await Promise.all([
    prisma.patch_resource.findMany({
      where,
      take: limit,
      skip: offset,
      orderBy: { created: 'desc' },
      include: {
        patch: {
          select: {
            name: true,
            unique_id: true
          }
        },
        user: {
          select: {
            id: true,
            name: true,
            avatar: true,
            role: true
          }
        },
        links: {
          orderBy: { sort_order: 'asc' }
        }
      }
    }),
    prisma.patch_resource.count({ where })
  ])

  const resources: AdminResource[] = await Promise.all(
    data.map(async (resource) => ({
      id: resource.id,
      name: resource.name,
      section: resource.section,
      uniqueId: resource.patch.unique_id,
      patchName: resource.patch.name,
      type: resource.type,
      language: resource.language,
      note: resource.note,
      noteHtml: resource.note ? await markdownToHtml(resource.note) : '',
      platform: resource.platform,
      emulatorType: resource.emulator_type,
      modelName: resource.model_name,
      download: resource.download,
      links: resource.links.map((link) => ({
        id: link.id,
        storage: link.storage,
        size: link.size,
        code: link.code,
        password: link.password,
        hash: link.hash,
        content: link.content,
        sortOrder: link.sort_order,
        download: link.download
      })),
      likeCount: 0,
      isLike: false,
      status: resource.status,
      userId: resource.user_id,
      patchId: resource.patch_id,
      created: String(resource.created),
      user: {
        id: resource.user.id,
        name: resource.user.name,
        avatar: resource.user.avatar,
        role: resource.user.role,
        patchCount: 0
      }
    }))
  )

  return { resources, total }
}
