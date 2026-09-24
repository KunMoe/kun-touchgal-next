import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { createFavoriteFolderSchema } from '~/validations/user'
import { USER_FAVORITE_PATCH_FOLDER_LIMIT } from '~/config/user'
import type { UserFavoritePatchFolder } from '~/types/api/user'

export const createFolder = async (
  input: z.infer<typeof createFavoriteFolderSchema>,
  uid: number
) => {
  const folderCount = await prisma.user_patch_favorite_folder.count({
    where: { user_id: uid }
  })
  if (folderCount > USER_FAVORITE_PATCH_FOLDER_LIMIT) {
    return `您最多创建 ${USER_FAVORITE_PATCH_FOLDER_LIMIT} 个收藏文件夹`
  }

  try {
    const folder = await prisma.user_patch_favorite_folder.create({
      data: {
        name: input.name,
        description: input.description,
        is_public: input.isPublic,
        user_id: uid
      },
      include: {
        _count: {
          select: { patch: true }
        }
      }
    })

    const response: UserFavoritePatchFolder = {
      name: folder.name,
      id: folder.id,
      description: folder.description,
      is_public: folder.is_public,
      isAdd: false,
      _count: folder._count
    }

    return response
  } catch (error) {
    // 该表唯一约束只有 [user_id, name], P2002 必为同名, 无需读 meta 区分字段
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return '您已有同名的收藏夹, 请更换名称'
    }
    throw error
  }
}
