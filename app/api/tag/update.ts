import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { updateTagSchema } from '~/validations/tag'
import { invalidateTagListCache } from './cache'
import {
  enqueueSearchOutboxBatch,
  kickSearchOutboxDrain
} from '~/server/search/sync'
import type { TagDetail } from '~/types/api/tag'

export const updateTag = async (input: z.infer<typeof updateTagSchema>) => {
  const { tagId, name, introduction = '', alias = [] } = input

  const existingTag = await prisma.patch_tag.findFirst({
    where: {
      OR: [{ name }, { alias: { has: name } }]
    }
  })
  if (existingTag && existingTag.id !== tagId) {
    return '这个标签已经存在了'
  }

  // 索引文档内嵌标签名，改名须重建全部关联 patch 的文档；仅改简介/别名不入文档
  //（别名解析在查询期实时读库），无需入队
  const currentTag = await prisma.patch_tag.findUnique({
    where: { id: tagId },
    select: { name: true }
  })
  const shouldSyncSearch = !!currentTag && currentTag.name !== name

  // 事务性入队：标签变更与写出箱入队原子提交，关闭崩溃丢失窗口
  const { newTag, patchIds } = await prisma.$transaction(async (tx) => {
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
    return { newTag, patchIds }
  })
  await invalidateTagListCache()
  if (patchIds.length > 0) {
    kickSearchOutboxDrain()
  }

  return newTag
}
