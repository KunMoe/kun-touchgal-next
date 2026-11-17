import {
  COMMENT_STATUS,
  RATING_STATUS,
  RESOURCE_STATUS
} from '~/constants/contentStatus'
import { invalidatePatchCommentCache } from '~/app/api/patch/comment/cache'
import { invalidatePatchContentCacheByPatchId } from '~/app/api/patch/cache'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
import { onCommentPublished } from '~/server/content/comment/publish'
import type {
  CommentStatus,
  RatingStatus,
  ResourceStatus
} from '~/constants/contentStatus'
import type { KunTxContext } from '~/server/db/tx'

// 一行内容在一次事务里实际发生的变化; before / after 为 null 表示行此前不存在 / 已删除。
// 只描述锁下真正迁移或删除的行, 不是入口打算改的行
export type ContentChange =
  | {
      kind: 'comment'
      id: number
      patchId: number
      resourceId: number | null
      before: CommentStatus | null
      after: CommentStatus | null
    }
  | {
      kind: 'rating'
      patchId: number
      before: RatingStatus | null
      after: RatingStatus | null
      // 公开评价的评分或推荐度被改动 (统计随之变化)
      scoreChanged: boolean
    }
  | {
      kind: 'resource'
      id: number
      patchId: number
      ownerId: number
      before: { status: ResourceStatus; section: string } | null
      after: { status: ResourceStatus; section: string } | null
    }

const isAwaitingVerdict = (status: ResourceStatus | undefined) =>
  status === RESOURCE_STATUS.awaitingApproval ||
  status === RESOURCE_STATUS.pending

const ascending = (ids: Set<number>) => [...ids].sort((a, b) => a - b)

// 「前后状态 → 提交后要失效的共享缓存」的唯一一份推导。各缓存装的都是公开基线, 所以
// 规则只看一行是否进出公开集, 入口不必再各自判断:
//   评论分页缓存     评论此前或此后公开 (含公开评论改正文)
//   补丁详情缓存     非资源评论进出公开集 (comment_count 变); 评价进出公开集, 或公开
//                    评价改了评分 (ratingSummary 变)。资源评论不计入 comment_count
//   资源详情缓存     资源此前或此后公开, 不分 section
//   资源列表缓存     同上, 且 section 为 patch (列表只列这一类)
//   作者待审标记缓存 资源进出待初审 / 待审核
// 守卫删除只匹配隐藏或待审的行, 按上面的规则自然不触发公开缓存的失效。
// 评论由非公开变为公开时, 另登记一次通知补发 (创建时被审核拦截而没发的那些),
// 排在全部缓存失效之后。
// 资源变化引起的补丁聚合 (type / language / platform) 失效跟随 recalcPatchType, 由执行
// 重算的命令自己登记, 不在这里
export const recordContentChanges = (
  ctx: Pick<KunTxContext, 'afterCommit'>,
  changes: ContentChange[]
) => {
  const commentPagePatchIds = new Set<number>()
  const publishedCommentIds: number[] = []
  const patchContentPatchIds = new Set<number>()
  const resourceDetailPatchIds = new Set<number>()
  const pendingOwnerIds = new Set<number>()
  let resourceListChanged = false

  for (const change of changes) {
    switch (change.kind) {
      case 'comment': {
        const wasPublic = change.before === COMMENT_STATUS.public
        const isPublic = change.after === COMMENT_STATUS.public
        if (wasPublic || isPublic) {
          commentPagePatchIds.add(change.patchId)
        }
        if (change.resourceId === null && wasPublic !== isPublic) {
          patchContentPatchIds.add(change.patchId)
        }
        if (!wasPublic && isPublic) {
          publishedCommentIds.push(change.id)
        }
        break
      }
      case 'rating': {
        const wasPublic = change.before === RATING_STATUS.public
        const isPublic = change.after === RATING_STATUS.public
        if (wasPublic !== isPublic || (wasPublic && change.scoreChanged)) {
          patchContentPatchIds.add(change.patchId)
        }
        break
      }
      case 'resource': {
        const wasPublic = change.before?.status === RESOURCE_STATUS.public
        const isPublic = change.after?.status === RESOURCE_STATUS.public
        if (wasPublic || isPublic) {
          resourceDetailPatchIds.add(change.patchId)
        }
        if (
          (wasPublic && change.before?.section === 'patch') ||
          (isPublic && change.after?.section === 'patch')
        ) {
          resourceListChanged = true
        }
        if (
          isAwaitingVerdict(change.before?.status) !==
          isAwaitingVerdict(change.after?.status)
        ) {
          pendingOwnerIds.add(change.ownerId)
        }
        break
      }
    }
  }

  const commentPageIds = ascending(commentPagePatchIds)
  if (commentPageIds.length) {
    ctx.afterCommit(`commentPage:${commentPageIds.join(',')}`, () =>
      Promise.all(commentPageIds.map(invalidatePatchCommentCache))
    )
  }
  const patchContentIds = ascending(patchContentPatchIds)
  if (patchContentIds.length) {
    ctx.afterCommit(`patchContent:${patchContentIds.join(',')}`, () =>
      invalidatePatchContentCacheByPatchId(patchContentIds)
    )
  }
  const resourceDetailIds = ascending(resourceDetailPatchIds)
  if (resourceDetailIds.length) {
    ctx.afterCommit(`resourceDetail:${resourceDetailIds.join(',')}`, () =>
      Promise.all(resourceDetailIds.map(invalidatePatchResourceDetailCache))
    )
  }
  if (resourceListChanged) {
    ctx.afterCommit('resourceList', invalidateResourceListCache)
  }
  const pendingOwners = ascending(pendingOwnerIds)
  if (pendingOwners.length) {
    ctx.afterCommit(`pendingResource:${pendingOwners.join(',')}`, () =>
      Promise.all(pendingOwners.map(invalidateUserPendingResourceCache))
    )
  }
  for (const commentId of publishedCommentIds) {
    ctx.afterCommit(`commentPublished:${commentId}`, () =>
      onCommentPublished(commentId)
    )
  }
}
