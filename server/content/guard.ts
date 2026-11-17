// 入口算好的、数据形状的守卫: 命令在行锁下拿它判定一行内容能不能动, 自己不做任何
// 角色比较。statusIn 是允许的状态; ownerUid 给出时还要求是作者本人
export interface ContentGuard<S extends number> {
  statusIn: readonly S[]
  ownerUid?: number
}

// status 一项带上锁下读到的状态: 入口据此区分「不存在」与「审核中」这类不同的文案
export type SkippedContent<S extends number> =
  | { id: number; reason: 'gone' }
  | { id: number; reason: 'owner' }
  | { id: number; reason: 'status'; status: S }

// 把请求的 id 分成通过守卫的行与被跳过的行, 都按 id 升序。locked 是行锁下读到的行;
// 不传守卫即不设条件 (后台删除)
export const applyContentGuard = <
  S extends number,
  R extends { id: number; user_id: number; status: number }
>(
  ids: number[],
  locked: R[],
  guard?: ContentGuard<S>
) => {
  const lockedById = new Map(locked.map((row) => [row.id, row]))
  const passed: R[] = []
  const skipped: SkippedContent<S>[] = []
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const row = lockedById.get(id)
    const status = row?.status as S
    if (!row) {
      skipped.push({ id, reason: 'gone' })
    } else if (
      guard?.ownerUid !== undefined &&
      row.user_id !== guard.ownerUid
    ) {
      skipped.push({ id, reason: 'owner' })
    } else if (guard && !guard.statusIn.includes(status)) {
      skipped.push({ id, reason: 'status', status })
    } else {
      passed.push(row)
    }
  }
  return { passed, skipped }
}
