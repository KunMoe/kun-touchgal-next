import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { getFavoriteFolderPatchSchema } from '~/validations/user'
import { GalgameCardSelectField, toGalgameCard } from '~/constants/api/select'

export const GET = kunRoute.get({
  auth: 'optional',
  input: getFavoriteFolderPatchSchema,
  handler: async ({ input, actor: payload }) =>
    getPatchByFolder(input, payload?.uid ?? 0)
})

const getPatchByFolder = async (
  input: z.infer<typeof getFavoriteFolderPatchSchema>,
  uid?: number
) => {
  const folder = await prisma.user_patch_favorite_folder.findUnique({
    where: { id: input.folderId }
  })
  if (!folder) {
    return '未找到该文件夹'
  }
  if (!folder.is_public && folder.user_id !== uid) {
    return '您无权查看该私密文件夹'
  }

  const { page, limit } = input
  const offset = (page - 1) * limit
  const where = { folder_id: input.folderId }

  const [total, relations] = await Promise.all([
    prisma.user_patch_favorite_folder_relation.count({ where }),
    prisma.user_patch_favorite_folder_relation.findMany({
      where,
      include: {
        patch: {
          select: GalgameCardSelectField
        }
      },
      skip: offset,
      take: limit,
      orderBy: [{ created: 'desc' }, { id: 'asc' }]
    })
  ])

  const patches: GalgameCard[] = relations.map((relation) =>
    toGalgameCard(relation.patch)
  )

  return { patches, total }
}
