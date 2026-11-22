import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import {
  invalidatePatchContentCache,
  invalidatePatchContentCacheByPatchId
} from '~/app/api/patch/cache'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import {
  invalidateResourceListCache,
  invalidateResourceStatsListCache
} from '~/app/api/resource/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
import { invalidateTagListCache } from '~/app/api/tag/cache'
import { invalidateCompanyListCache } from '~/app/api/company/cache'
import { planKunInvalidations } from './plan'
import type { KunChange } from './changes'
import type { KunCacheTarget } from './plan'
import type { KunTxContext } from '~/server/db/tx'

// 规划结果的执行: 把目标映射到各缓存模块现有的失效 helper。失效与失效之间没有顺序约束;
// 要单条命令完成的 (补丁详情两键一条 DEL) 由 helper 自己保证

type KunInvalidation = [key: string, run: () => Promise<unknown>]

const ascending = (ids: number[]) => [...new Set(ids)].sort((a, b) => a - b)

// key 由缓存种类与作用的 id 组成, 同一事务里重复登记同一批不会重复执行。按 patch 分片的缓存
// 一种一条, 补丁详情按 id 回库查的合成一次查询
const toInvalidations = (
  targets: readonly KunCacheTarget[]
): KunInvalidation[] => {
  const commentPageIds: number[] = []
  const contentUniqueIds: string[] = []
  const contentPatchIds: number[] = []
  const resourceDetailIds: number[] = []
  const pendingOwnerIds: number[] = []
  const flags = new Set<KunCacheTarget['cache']>()
  for (const target of targets) {
    switch (target.cache) {
      case 'commentPage':
        commentPageIds.push(target.patchId)
        break
      case 'patchContent':
        if (target.uniqueId !== undefined) {
          contentUniqueIds.push(target.uniqueId)
        } else {
          contentPatchIds.push(target.patchId)
        }
        break
      case 'resourceDetail':
        resourceDetailIds.push(target.patchId)
        break
      case 'pendingResource':
        pendingOwnerIds.push(target.uid)
        break
      default:
        flags.add(target.cache)
    }
  }

  const invalidations: KunInvalidation[] = []
  const commentPages = ascending(commentPageIds)
  if (commentPages.length) {
    invalidations.push([
      `commentPage:${commentPages.join(',')}`,
      () =>
        Promise.all(commentPages.map((id) => invalidatePatchCommentCache(id)))
    ])
  }
  for (const uniqueId of [...new Set(contentUniqueIds)].sort()) {
    invalidations.push([
      `patchContent:unique:${uniqueId}`,
      () => invalidatePatchContentCache(uniqueId)
    ])
  }
  const contentIds = ascending(contentPatchIds)
  if (contentIds.length) {
    invalidations.push([
      `patchContent:${contentIds.join(',')}`,
      () => invalidatePatchContentCacheByPatchId(contentIds)
    ])
  }
  const resourceDetails = ascending(resourceDetailIds)
  if (resourceDetails.length) {
    invalidations.push([
      `resourceDetail:${resourceDetails.join(',')}`,
      () =>
        Promise.all(
          resourceDetails.map((id) => invalidatePatchResourceDetailCache(id))
        )
    ])
  }
  if (flags.has('resourceList')) {
    invalidations.push(['resourceList', () => invalidateResourceListCache()])
  }
  if (flags.has('resourceStatsList')) {
    invalidations.push([
      'resourceStatsList',
      () => invalidateResourceStatsListCache()
    ])
  }
  const pendingOwners = ascending(pendingOwnerIds)
  if (pendingOwners.length) {
    invalidations.push([
      `pendingResource:${pendingOwners.join(',')}`,
      () =>
        Promise.all(
          pendingOwners.map((uid) => invalidateUserPendingResourceCache(uid))
        )
    ])
  }
  if (flags.has('tagList')) {
    invalidations.push(['tagList', () => invalidateTagListCache()])
  }
  if (flags.has('companyList')) {
    invalidations.push(['companyList', () => invalidateCompanyListCache()])
  }
  return invalidations
}

// 写路径的入口: 在 kunTx 的回调里登记, 提交之后由执行器逐条执行、各自隔离, 失败只记日志;
// 没有提交则不执行。事务内失效会被并发读回填旧值 (M-04), 所以只能登记到提交之后。
// 有可能抛错的提交后副作用 (通知、出箱 kick) 写在 kunTx 返回之后, 自然排在这些失效后面
export const recordKunChanges = (
  ctx: Pick<KunTxContext, 'afterCommit'>,
  changes: readonly KunChange[]
) => {
  for (const [key, run] of toInvalidations(planKunInvalidations(changes))) {
    ctx.afterCommit(key, run)
  }
}
