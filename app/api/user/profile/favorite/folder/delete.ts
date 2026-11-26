import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunLog } from '~/lib/log.server'
import { kunTx } from '~/server/db/tx'
import { recordKunChanges } from '~/server/cache/publish'
import {
  bumpPatchFavoriteCacheVersion,
  invalidatePatchFavoriteCaches
} from '~/app/api/patch/cache'
import type { favoriteFolderIdSchema } from '~/validations/user'

const PATCH_FAVORITE_EXACT_INVALIDATE_LIMIT = 500

export const deleteFolder = async (
  input: z.infer<typeof favoriteFolderIdSchema>,
  uid: number
) => {
  const folder = await prisma.user_patch_favorite_folder.findUnique({
    where: { id: input.folderId }
  })
  if (!folder) {
    return '未找到该收藏夹'
  }
  if (folder.user_id !== uid) {
    return '您没有权限删除该收藏夹'
  }

  const relations = await prisma.user_patch_favorite_folder_relation.findMany({
    where: { folder_id: input.folderId },
    select: {
      patch: {
        select: {
          unique_id: true
        }
      }
    },
    take: PATCH_FAVORITE_EXACT_INVALIDATE_LIMIT + 1
  })
  const truncated = relations.length > PATCH_FAVORITE_EXACT_INVALIDATE_LIMIT

  // 收藏关系随级联消失, 所以补丁在删除之前读; 只取 id, 不受上面的精确失效上限限制
  await kunTx('favorite.folder.delete', async (ctx) => {
    const removed = await ctx.tx.user_patch_favorite_folder_relation.findMany({
      where: { folder_id: input.folderId },
      select: { patch_id: true }
    })
    await ctx.tx.user_patch_favorite_folder.delete({
      where: { id: input.folderId }
    })
    recordKunChanges(ctx, [
      {
        kind: 'favoritesRemoved',
        patchIds: removed.map((relation) => relation.patch_id)
      }
    ])
  })

  try {
    if (truncated) {
      await bumpPatchFavoriteCacheVersion(uid)
    } else {
      await invalidatePatchFavoriteCaches(
        relations.map((relation) => relation.patch.unique_id),
        uid
      )
    }
  } catch (error) {
    // 缓存失效失败不影响删除结果
    kunLog(
      'cache.invalidate_failed',
      { ns: 'patch:favorite', op: truncated ? 'bump_version' : 'del' },
      error
    )
  }

  return {}
}
