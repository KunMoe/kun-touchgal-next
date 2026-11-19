import { kunTx } from '~/server/db/tx'
import { normalizeStringArray } from '~/utils/normalizeStringArray'
import type { Prisma } from '~/prisma/generated/prisma/client'

// 手动标签的一次修改意图: 按 id 移除、按名新增。不携带「现存标签的全集」, 所以表单基线
// 陈旧、名字在往返中被改写都不会变成关联的增删; 两项都为空就是不动, 「清空」要把现存
// 标签的 id 列全
export interface ManualTagChange {
  removeTagIds: number[]
  addTagNames: string[]
}

// 按码元比较: 不随运行环境的 locale 变, 任何进程排出来的顺序都一样
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// 首参是事务客户端: 现在由下面的 saveManualTagChange 单独开事务调用, 以后要并进
// 「一次保存一个事务」只需改调用点
export const applyManualTagChange = async (
  tx: Prisma.TransactionClient,
  patchId: number,
  change: ManualTagChange,
  uid: number
): Promise<{ changed: boolean }> => {
  const addNames = normalizeStringArray(change.addTagNames)
  const removeIds = [...new Set(change.removeTagIds)]
  if (!addNames.length && !removeIds.length) {
    return { changed: false }
  }

  const candidateTags = addNames.length
    ? await tx.patch_tag.findMany({
        where: {
          OR: [{ name: { in: addNames } }, { alias: { hasSome: addNames } }]
        },
        select: { id: true, name: true, alias: true },
        orderBy: { id: 'asc' }
      })
    : []

  // 输入串解析到规范标签: name 精确匹配优先, 未命中再按 alias 补 (同一串可能既是 A 的
  // 别名又是 B 的名字), 输入别名时只关联规范标签而不新建重复标签
  const tagByName = new Map(candidateTags.map((tag) => [tag.name, tag]))
  const resolvedTagIds = new Set<number>()
  const namesToCreate: string[] = []
  for (const name of addNames) {
    const resolved =
      tagByName.get(name) ??
      candidateTags.find((tag) => tag.alias.includes(name))
    if (resolved) {
      resolvedTagIds.add(resolved.id)
    } else {
      namesToCreate.push(name)
    }
  }

  // 只移除这个 Galgame 确实关联着的: 表单基线陈旧时带来的 id (已被别人解除、标签已删)
  // 落空即可
  const relatedToRemove = removeIds.length
    ? await tx.patch_tag_relation.findMany({
        where: { patch_id: patchId, tag_id: { in: removeIds } },
        select: { tag_id: true }
      })
    : []
  // 正要移除的标签又被按名字或别名加了回来时, 它同时落在候删集与解析集; 事务内先 INSERT
  // 后 DELETE, skipDuplicates 跳过插入后 DELETE 会把它删掉, 故从删除集剔除
  const tagIdsToRemove = relatedToRemove
    .map((relation) => relation.tag_id)
    .filter((id) => !resolvedTagIds.has(id))

  // 计数触发器只保证单语句内按 tag_id 升序加锁; 本事务先 INSERT 后 DELETE, 两语句锁集
  // 分离, 与反向并发编辑成环死锁。第一条取锁的语句对并集升序预加锁建立全序 (前面的读不
  // 取行锁)。FOR NO KEY UPDATE 与 FK RI 的 KEY SHARE 相容, 只串行化触发器 UPDATE count
  // 的竞争者。新建的 tag 不入锁集: 未提交的新行对并发事务不可见, 无竞争者
  const lockIds = [...new Set([...resolvedTagIds, ...tagIdsToRemove])].sort(
    (a, b) => a - b
  )
  if (lockIds.length > 0) {
    await tx.$queryRaw`SELECT id FROM patch_tag WHERE id = ANY(${lockIds}::int4[]) ORDER BY id FOR NO KEY UPDATE`
  }

  // 按名排序后一条语句插入: 两个并发事务引入同一批新名字时, 以相同的顺序去等对方在
  // patch_tag.name 唯一索引上的条目, 不会互等。skipDuplicates 让后到者跳过已被对方建好
  // 的名字 (否则撞唯一索引, 而这时 patch 的主事务已经提交), 再按名回读拿到那一行
  const sortedNames = [...namesToCreate].sort(byCodeUnit)
  const created =
    sortedNames.length > 0
      ? await tx.patch_tag.createMany({
          data: sortedNames.map((name) => ({
            user_id: uid,
            name,
            source: 'self'
          })),
          skipDuplicates: true
        })
      : { count: 0 }
  const newTags =
    sortedNames.length > 0
      ? await tx.patch_tag.findMany({
          where: { name: { in: sortedNames } },
          select: { id: true }
        })
      : []

  const tagIdsToRelate = [...resolvedTagIds, ...newTags.map((tag) => tag.id)]
  const inserted =
    tagIdsToRelate.length > 0
      ? await tx.patch_tag_relation.createMany({
          data: tagIdsToRelate.map((tagId) => ({
            patch_id: patchId,
            tag_id: tagId
          })),
          skipDuplicates: true
        })
      : { count: 0 }

  const deleted =
    tagIdsToRemove.length > 0
      ? await tx.patch_tag_relation.deleteMany({
          where: { patch_id: patchId, tag_id: { in: tagIdsToRemove } }
        })
      : { count: 0 }

  return {
    changed: created.count > 0 || inserted.count > 0 || deleted.count > 0
  }
}

export const saveManualTagChange = async (
  patchId: number,
  change: ManualTagChange,
  uid: number
): Promise<{ changed: boolean }> => {
  if (!change.removeTagIds.length && !change.addTagNames.length) {
    return { changed: false }
  }

  const result = await kunTx(
    'edit.manualTag',
    ({ tx }) => applyManualTagChange(tx, patchId, change, uid),
    { timeout: 60000 }
  )
  // 回调里没有 fail, 走不到字符串结果
  if (typeof result === 'string') {
    throw new Error(result)
  }
  return result
}
