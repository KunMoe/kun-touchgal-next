import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'
import { recordKunChanges } from '~/server/cache/publish'
import { invalidateTagListCache } from './cache'
import {
  enqueueSearchOutboxBatch,
  kickSearchOutboxDrain
} from '~/server/search/sync'

export const deleteTag = async (tagId: number) => {
  const tag = await prisma.patch_tag.findUnique({
    where: { id: tagId }
  })
  if (!tag) {
    return '未找到对应的标签'
  }

  // 索引文档内嵌标签名与 tagIds，FK Cascade 会随删除清掉关系行，因此关联 patch
  // 必须在删除前读取；删除与入队原子提交，消费者按 DB 最新状态重建文档
  const patchIds = await kunTx('tag.delete', async (ctx) => {
    const { tx } = ctx
    const relations = await tx.patch_tag_relation.findMany({
      where: { tag_id: tagId },
      select: { patch_id: true }
    })
    await tx.patch_tag.delete({
      where: { id: tagId }
    })
    const patchIds = relations.map((relation) => relation.patch_id)
    await enqueueSearchOutboxBatch(tx, patchIds)
    recordKunChanges(ctx, [
      { kind: 'taxonomyDeleted', taxonomy: 'tag', patchIds }
    ])
    return patchIds
  })
  if (typeof patchIds === 'string') {
    return patchIds
  }
  await invalidateTagListCache()
  if (patchIds.length > 0) {
    kickSearchOutboxDrain()
  }

  return {}
}
