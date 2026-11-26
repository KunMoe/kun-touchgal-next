import { prisma } from '~/prisma/index'
import { kunLog } from '~/lib/log.server'
import { GalgameCardSelectField, toGalgameCard } from '~/constants/api/select'
import {
  toPatchWhere,
  type PatchVisibility
} from '~/server/viewer/patchVisibility'

// 索引只回答「哪些 id、按什么顺序」, 卡片内容与可见性在这里由 PG 裁决。
// 索引是异步写入的派生副本, 写入失败时陈旧没有上界: 作品已删除、分级已改、打上了被屏蔽的
// 标签之后, 旧文档仍会被索引 filter 放行。所以 filter 里的分级 / 屏蔽标签只算召回预筛,
// 同一个视角要在这条查询里再套一次。
// 这里只重判可见性: 属于哪个标签 / 会社、符合哪些筛选仍是索引说了算, 陈旧时会多列或漏列。
// 返回值按 ids 的顺序排列; 库里已不存在或对此视角不可见的 id 被丢弃, 结果可能比 ids 短
export const fetchGalgameCardsByIds = async (
  ids: number[],
  visibility: PatchVisibility
): Promise<GalgameCard[]> => {
  if (ids.length === 0) {
    return []
  }

  const rows = await prisma.patch.findMany({
    where: { AND: [{ id: { in: ids } }, toPatchWhere(visibility)] },
    select: GalgameCardSelectField
  })
  const rowById = new Map(rows.map((row) => [row.id, row]))

  const dropped = ids.filter((id) => !rowById.has(id))
  if (dropped.length > 0) {
    // 索引命中的作品已不在库里或对此视角不可见: 索引与库不一致的信号, 持续出现同一批 id
    // 说明这些文档的同步卡住了
    kunLog('search.hits_dropped', {
      requested: ids.length,
      dropped: dropped.length,
      ids: dropped.join(',')
    })
  }

  return ids.flatMap((id) => {
    const row = rowById.get(id)
    return row ? [toGalgameCard(row)] : []
  })
}
