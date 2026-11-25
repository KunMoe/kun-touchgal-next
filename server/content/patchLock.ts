import type { KunTx } from '~/prisma/index'

// 按 id 升序锁 patch 行, 须在锁完内容行之后、第一条会触发计数触发器的写语句之前调用。
//
// 计数触发器 (resource_count / comment_count) 是行级的: 语句改到哪一行内容, 就在那一刻
// 去 UPDATE 它所属的 patch。一批内容跨多个补丁时, patch 行的加锁顺序于是跟着内容行的
// 处理顺序走, 两个互不相交的批次会在 patch 行上反序互等。先按 patch id 升序把这些行
// 锁住, 触发器再来只是重入。
//
// 用 FOR NO KEY UPDATE: 与触发器里的 UPDATE 同级; FOR UPDATE 会和并发 INSERT 经外键对
// patch 行取的 FOR KEY SHARE 冲突。顶层 SELECT 的加锁节点在排序之上, 先排后锁
export const lockPatchRows = async (tx: KunTx, patchIds: number[]) => {
  if (!patchIds.length) {
    return
  }
  await tx.$executeRaw`
    SELECT id
    FROM patch
    WHERE id = ANY(${patchIds}::int[])
    ORDER BY id
    FOR NO KEY UPDATE`
}
