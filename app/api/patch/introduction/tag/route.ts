import * as z from 'zod'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { kunTx } from '~/server/db/tx'
import { patchTagChangeSchema } from '~/validations/patch'
import { enqueueSearchOutbox } from '~/server/search/sync'
import { invalidateTagListCache } from '~/app/api/tag/cache'
import { patchRelationHandler } from '~/app/api/patch/introduction/_relationRoute'

const handlePatchTagAction = (type: 'add' | 'delete') => {
  const isAdd = type === 'add'
  return async (
    input: z.infer<typeof patchTagChangeSchema>
  ): Promise<boolean | string> => {
    const { patchId, tagId } = input

    return await kunTx(`patch.tag.${type}`, async ({ tx: prisma }) => {
      const existing = await prisma.patch_tag_relation.findMany({
        where: { patch_id: patchId, tag_id: { in: tagId } },
        select: { tag_id: true }
      })
      const existingIds = new Set(existing.map((r) => r.tag_id))

      const affected = isAdd
        ? tagId.filter((id) => !existingIds.has(id))
        : tagId.filter((id) => existingIds.has(id))

      if (affected.length === 0) {
        return false
      }

      if (isAdd) {
        await prisma.patch_tag_relation.createMany({
          data: affected.map((id) => ({ patch_id: patchId, tag_id: id }))
        })
      } else {
        await prisma.patch_tag_relation.deleteMany({
          where: { patch_id: patchId, tag_id: { in: affected } }
        })
      }

      // 事务性入队：与标签/会社变更原子提交，关闭崩溃丢失窗口
      await enqueueSearchOutbox(prisma, patchId)

      return true
    })
  }
}

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'tag.manage',
  input: patchTagChangeSchema,
  handler: patchRelationHandler({
    mutate: handlePatchTagAction('add'),
    invalidateListCache: invalidateTagListCache
  })
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'tag.manage',
  input: patchTagChangeSchema,
  handler: patchRelationHandler({
    mutate: handlePatchTagAction('delete'),
    invalidateListCache: invalidateTagListCache
  })
})
