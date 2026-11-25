import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { isFavoriteFolderVisibleTo } from '~/app/api/utils/contentVisibility'
import { getFavoriteFolderPatchSchema } from '~/validations/user'
import { GalgameCardSelectField, toGalgameCard } from '~/constants/api/select'

// 公开收藏夹的内容与个人主页同样只给登录用户看 (9-03 发现 2 站长裁定)
export const GET = kunRoute.get({
  auth: 'user',
  input: getFavoriteFolderPatchSchema,
  handler: async ({ input, actor }) => getPatchByFolder(input, actor.uid)
})

const getPatchByFolder = async (
  input: z.infer<typeof getFavoriteFolderPatchSchema>,
  uid: number
) => {
  const folder = await prisma.user_patch_favorite_folder.findUnique({
    where: { id: input.folderId }
  })
  if (!folder) {
    return '未找到该文件夹'
  }
  if (!isFavoriteFolderVisibleTo(folder, uid)) {
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
