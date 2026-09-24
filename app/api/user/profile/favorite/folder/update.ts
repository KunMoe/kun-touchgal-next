import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { updateFavoriteFolderSchema } from '~/validations/user'
import type { UserFavoritePatchFolder } from '~/types/api/user'

export const updateFolder = async (
  input: z.infer<typeof updateFavoriteFolderSchema>,
  uid: number
) => {
  try {
    const { count } = await prisma.user_patch_favorite_folder.updateMany({
      where: { id: input.folderId, user_id: uid },
      data: {
        name: input.name,
        description: input.description,
        is_public: input.isPublic
      }
    })
    if (count === 0) {
      return '未找到该收藏夹或没有权限更新'
    }
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return '您已有同名的收藏夹, 请更换名称'
    }
    throw error
  }

  const folder = await prisma.user_patch_favorite_folder.findUnique({
    where: { id: input.folderId },
    include: {
      _count: {
        select: { patch: true }
      }
    }
  })
  if (!folder) {
    return '未找到该收藏夹'
  }

  const response: UserFavoritePatchFolder = {
    name: folder.name,
    id: folder.id,
    description: folder.description,
    is_public: folder.is_public,
    isAdd: false,
    _count: folder._count
  }

  return response
}
