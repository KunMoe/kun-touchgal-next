import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { recordKunChanges } from '~/server/cache/publish'
import { findTermConflict, tagTerms } from '~/server/term/identity'
import { normalizeAliasList } from '~/utils/term/normalize'
import { updateTagSchema } from '~/validations/tag'
import { invalidateTagListCache } from './cache'
import {
  enqueueSearchOutboxBatch,
  kickSearchOutboxDrain
} from '~/server/search/sync'
import type { TagDetail } from '~/types/api/tag'

export const updateTag = async (input: z.infer<typeof updateTagSchema>) => {
  const { tagId, name, introduction = '', alias = [] } = input

  const currentTag = await prisma.patch_tag.findUnique({
    where: { id: tagId },
    select: { name: true, alias: true }
  })
  // 只查这次新加的别名: 存量里已经撞上别人的不拦, 否则只改简介也存不了
  const currentAliases = new Set(normalizeAliasList(currentTag?.alias ?? []))
  const conflict = await findTermConflict(prisma, tagTerms, {
    name,
    addedAliases: alias.filter((item) => !currentAliases.has(item)),
    selfId: tagId
  })
  if (conflict) {
    return conflict
  }

  // 索引文档内嵌标签名，改名须重建全部关联 patch 的文档；仅改简介/别名不入文档
  //（别名解析在查询期实时读库），无需入队
  const shouldSyncSearch = !!currentTag && currentTag.name !== name

  // 事务性入队：标签变更与写出箱入队原子提交，关闭崩溃丢失窗口
  const result = await kunTx(
    'tag.update',
    async (ctx) => {
      const { tx } = ctx
      const newTag: TagDetail = await tx.patch_tag.update({
        where: { id: tagId },
        data: {
          name,
          introduction,
          alias
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              avatar: true
            }
          }
        }
      })
      const patchIds = shouldSyncSearch
        ? (
            await tx.patch_tag_relation.findMany({
              where: { tag_id: tagId },
              select: { patch_id: true }
            })
          ).map((relation) => relation.patch_id)
        : []
      await enqueueSearchOutboxBatch(tx, patchIds)
      if (shouldSyncSearch) {
        recordKunChanges(ctx, [
          { kind: 'taxonomyRenamed', taxonomy: 'tag', patchIds }
        ])
      }
      return { newTag, patchIds }
    },
    // name 唯一索引兜底并发改名
    { violations: { P2002: '这个标签已经存在了' } }
  )
  if (typeof result === 'string') {
    return result
  }
  const { newTag, patchIds } = result
  await invalidateTagListCache()
  if (patchIds.length > 0) {
    kickSearchOutboxDrain()
  }

  return newTag
}
