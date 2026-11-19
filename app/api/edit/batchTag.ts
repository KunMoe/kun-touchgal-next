import { prisma } from '~/prisma/index'
import { kunTx } from '~/server/db/tx'

export const handleBatchPatchTags = async (
  patchId: number,
  tagArray: string[],
  uid: number
) => {
  const validTags = tagArray.filter(Boolean)

  const existingRelations = await prisma.patch_tag_relation.findMany({
    where: { patch_id: patchId },
    include: { tag: true }
  })

  const existingTagNames = existingRelations.map((rel) => rel.tag.name)
  const tagsToAdd = validTags.filter((tag) => !existingTagNames.includes(tag))
  const removalCandidateIds = existingRelations
    .filter((rel) => !validTags.includes(rel.tag.name))
    .map((rel) => rel.tag_id)

  const existingTags =
    tagsToAdd.length > 0
      ? await prisma.patch_tag.findMany({
          where: {
            OR: tagsToAdd.map((tag) => ({
              OR: [{ name: tag }, { alias: { has: tag } }]
            }))
          }
        })
      : []

  // 输入串解析到规范标签: name 精确匹配优先, 未命中再按 alias 补(同一串可能
  // 既是 A 的别名又是 B 的名字), 输入别名时只关联规范标签而不新建重复标签
  const tagByName = new Map(existingTags.map((tag) => [tag.name, tag]))
  const resolvedIdByInput = new Map<string, number>()
  for (const input of tagsToAdd) {
    const resolved =
      tagByName.get(input) ??
      existingTags.find((tag) => tag.alias.includes(input))
    if (resolved) {
      resolvedIdByInput.set(input, resolved.id)
    }
  }

  const tagsToCreate = [
    ...new Set(tagsToAdd.filter((tag) => !resolvedIdByInput.has(tag)))
  ]
  const resolvedTagIdSet = new Set(resolvedIdByInput.values())
  // 提交列表用别名替换名字时, 规范标签同时落在候删集与解析集; 事务内先 INSERT
  // 后 DELETE, skipDuplicates 跳过插入后 DELETE 会把它删掉, 故从删除集剔除
  const tagsToRemove = removalCandidateIds.filter(
    (id) => !resolvedTagIdSet.has(id)
  )

  // 计数触发器只保证单语句内按 tag_id 升序加锁; 本事务先 INSERT 后 DELETE,
  // 两语句锁集分离, 与反向并发编辑成环死锁。事务首条对并集升序预加锁建立全序。
  // FOR NO KEY UPDATE 与 FK RI 的 KEY SHARE 相容, 只串行化触发器 UPDATE count 的竞争者。
  // tagsToCreate 新建的 tag 不入锁集: 未提交的新行对并发事务不可见, 无竞争者。
  const lockIds = [
    ...new Set([...existingTags.map((tag) => tag.id), ...tagsToRemove])
  ].sort((a, b) => a - b)

  const failure = await kunTx(
    'edit.batchTag',
    async ({ tx }) => {
      if (lockIds.length > 0) {
        await tx.$queryRaw`SELECT id FROM patch_tag WHERE id = ANY(${lockIds}::int4[]) ORDER BY id FOR NO KEY UPDATE`
      }

      if (tagsToCreate.length > 0) {
        await tx.patch_tag.createMany({
          data: tagsToCreate.map((name) => ({
            user_id: uid,
            name,
            source: 'self'
          }))
        })
      }

      const newTags =
        tagsToCreate.length > 0
          ? await tx.patch_tag.findMany({
              where: { name: { in: tagsToCreate } },
              select: { id: true, name: true }
            })
          : []

      const allTagIds = [...resolvedTagIdSet, ...newTags.map((t) => t.id)]

      if (allTagIds.length > 0) {
        await tx.patch_tag_relation.createMany({
          data: allTagIds.map((tagId) => ({
            patch_id: patchId,
            tag_id: tagId
          })),
          skipDuplicates: true
        })
      }

      if (tagsToRemove.length > 0) {
        await tx.patch_tag_relation.deleteMany({
          where: { patch_id: patchId, tag_id: { in: tagsToRemove } }
        })
      }
    },
    { timeout: 60000 }
  )
  // 回调里没有 fail, 走不到字符串结果
  if (typeof failure === 'string') {
    throw new Error(failure)
  }

  return {
    success: true,
    changed: tagsToAdd.length > 0 || tagsToRemove.length > 0
  }
}
