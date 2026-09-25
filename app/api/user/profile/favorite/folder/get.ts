import * as z from 'zod'
import { prisma } from '~/prisma/index'
import type { UserFavoritePatchFolder } from '~/types/api/user'

const patchIdSchema = z.object({
  patchId: z.coerce.number().min(1).max(9999999).optional(),
  page: z.coerce.number().min(1).max(9999999).optional(),
  limit: z.coerce.number().min(1).max(100).optional()
})

export const getFolders = async (
  input: z.infer<typeof patchIdSchema>,
  pageUid: number,
  currentUserUid: number
) => {
  const where = {
    user_id: pageUid,
    is_public: pageUid !== currentUserUid ? true : undefined
  }

  const paginated = input.page != null && input.limit != null

  const [folders, total] = await Promise.all([
    prisma.user_patch_favorite_folder.findMany({
      where,
      include: {
        patch: {
          where: {
            patch_id: input.patchId ?? 0
          }
        },
        // 关系 _count 会被 Prisma 编译成子表整表 GROUP BY, 外层 user_id 下推不进去
        // (C16, 每次 ~95ms); 这个对返回行恒真的过滤会编进聚合子查询, 让它走索引
        _count: {
          select: { patch: { where: { folder: { user_id: pageUid } } } }
        }
      },
      orderBy: { created: 'desc' },
      skip: paginated ? (input.page! - 1) * input.limit! : undefined,
      take: paginated ? input.limit : undefined
    }),
    paginated
      ? prisma.user_patch_favorite_folder.count({ where })
      : Promise.resolve(0)
  ])

  const response: UserFavoritePatchFolder[] = folders.map((f) => ({
    name: f.name,
    id: f.id,
    description: f.description,
    is_public: f.is_public,
    isAdd: f.patch.length > 0,
    _count: f._count
  }))

  return { folders: response, total }
}
