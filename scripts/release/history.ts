// 发布目录里记着这个发布在线上结局的两个标记。deploy:rollback 的默认目标与部署成功后的清理只认它们:
// 没上线过的 (组装之后部署被打断) 与被回滚掉的发布不该成为默认的回滚目标, 也不该占保留名额
import fs from 'fs'
import path from 'path'
import { planPrune, releaseDirOf } from './layout'
import type { ReleaseId, ReleaseLayout } from './layout'

// 过了闸门与观察期的时刻 (ISO), 再次上线时覆盖
export const KUN_RELEASE_ACTIVATED = '.kun-activated'
// 从它回滚走的时刻, 或者它没有通过闸门的时刻
export const KUN_RELEASE_ROLLED_BACK = '.kun-rolled-back'

const markerOf = (layout: ReleaseLayout, id: ReleaseId, name: string) =>
  path.join(releaseDirOf(layout, id), name)

export const isReleaseActivated = (layout: ReleaseLayout, id: ReleaseId) =>
  fs.existsSync(markerOf(layout, id, KUN_RELEASE_ACTIVATED))

export const isReleaseRolledBack = (layout: ReleaseLayout, id: ReleaseId) =>
  fs.existsSync(markerOf(layout, id, KUN_RELEASE_ROLLED_BACK))

export const isKnownGoodRelease = (layout: ReleaseLayout, id: ReleaseId) =>
  isReleaseActivated(layout, id) && !isReleaseRolledBack(layout, id)

// 又一次过了闸门就是最新的结论: 以前被回滚过的标记一并去掉
export const markReleaseActivated = (
  layout: ReleaseLayout,
  id: ReleaseId,
  at: Date
) => {
  fs.writeFileSync(
    markerOf(layout, id, KUN_RELEASE_ACTIVATED),
    `${at.toISOString()}\n`
  )
  fs.rmSync(markerOf(layout, id, KUN_RELEASE_ROLLED_BACK), { force: true })
}

export const markReleaseRolledBack = (
  layout: ReleaseLayout,
  id: ReleaseId,
  at: Date
) => {
  fs.writeFileSync(
    markerOf(layout, id, KUN_RELEASE_ROLLED_BACK),
    `${at.toISOString()}\n`
  )
}

// 部署成功之后要删的发布: 不在线的发布里, 没上线过或被回滚过的一律删; 其余的按 planPrune 留下最新的
// 几个与在线的那一个
export const planReleasePrune = (
  layout: ReleaseLayout,
  ids: readonly ReleaseId[],
  currentId: ReleaseId
): ReleaseId[] => {
  const unwanted = ids.filter(
    (id) => id !== currentId && !isKnownGoodRelease(layout, id)
  )
  const rest = ids.filter((id) => !unwanted.includes(id))
  return [...unwanted, ...planPrune(rest, currentId)]
}
