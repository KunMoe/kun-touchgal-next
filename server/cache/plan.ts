import {
  COMMENT_CACHE_DURATION,
  GALGAME_LIST_CACHE_DURATION,
  HOME_CACHE_DURATION,
  PATCH_CACHE_DURATION,
  PATCH_INTRODUCTION_CACHE_DURATION,
  PATCH_RESOURCE_DETAIL_CACHE_DURATION,
  RESOURCE_LIST_CACHE_DURATION
} from '~/config/cache'
import {
  COMMENT_STATUS,
  RATING_STATUS,
  RESOURCE_STATUS
} from '~/constants/contentStatus'
import type { ResourceStatus } from '~/constants/contentStatus'
import type { KunChange, KunResourceState } from './changes'

// 「哪次写入改到了哪个共享缓存内嵌的字段」的唯一一份知识: 领域变更 → 提交后要失效的缓存。
// 纯函数, 不做 I/O; 执行在 publish.ts。各缓存装的都是公开基线, 所以内容行的规则只看它是否
// 进出公开集。新增写路径只需回答「改了哪个实体、前后是什么状态」, 不要在处理器里再推一遍。

export type KunCacheTarget =
  // 评论分页 (app/api/patch/comment/cache.ts), 按 patch 分片
  | { cache: 'commentPage'; patchId: number }
  // 补丁详情两键 patch:<uniqueId> 与 patch:introduction:* (app/api/patch/cache.ts)。
  // 知道 uniqueId 时直接删键; 不知道时按 id 回库查 (被删的 patch 查不到, 所以删除必须带上)
  | { cache: 'patchContent'; patchId: number; uniqueId?: string }
  // 资源详情 (app/api/patch/resource/cache.ts), 装该 patch 下 status=0 的全部 section
  | { cache: 'resourceDetail'; patchId: number }
  // 资源列表 (app/api/resource/cache.ts), 只列 section=patch 的公开资源
  | { cache: 'resourceList' }
  // 资源列表里按下载数 / 点赞数排序的那一类
  | { cache: 'resourceStatsList' }
  // 作者的待审标记 (app/api/utils/pendingResourceCache.ts)
  | { cache: 'pendingResource'; uid: number }
  // 标签列表与会社列表 (内嵌触发器维护的作品数)
  | { cache: 'tagList' }
  | { cache: 'companyList' }

const isAwaitingVerdict = (status: ResourceStatus | undefined) =>
  status === RESOURCE_STATUS.awaitingApproval ||
  status === RESOURCE_STATUS.pending

// 资源闸门, 全仓只此一份。详情缓存不分 section, 列表只装 section=patch; 待审标记看的是
// 「待初审或待审核」这一集合的进出, 不是某个具体状态
export const resourceTransition = (
  before: KunResourceState | null,
  after: KunResourceState | null
) => {
  const wasPublic = before?.status === RESOURCE_STATUS.public
  const isPublic = after?.status === RESOURCE_STATUS.public
  return {
    touchesPublic: wasPublic || isPublic,
    touchesListed:
      (wasPublic && before?.section === 'patch') ||
      (isPublic && after?.section === 'patch'),
    pendingFlip:
      isAwaitingVerdict(before?.status) !== isAwaitingVerdict(after?.status)
  }
}

const targetKey = (target: KunCacheTarget) => {
  switch (target.cache) {
    case 'commentPage':
    case 'patchContent':
    case 'resourceDetail':
      return `${target.cache}:${target.patchId}`
    case 'pendingResource':
      return `${target.cache}:${target.uid}`
    default:
      return target.cache
  }
}

export const planKunInvalidations = (
  changes: readonly KunChange[]
): KunCacheTarget[] => {
  const targets: KunCacheTarget[] = []
  const deletedPatchIds = new Set<number>()

  for (const change of changes) {
    switch (change.kind) {
      case 'comment': {
        const wasPublic = change.before === COMMENT_STATUS.public
        const isPublic = change.after === COMMENT_STATUS.public
        // 公开评论的正文改动也要换分页里的内容
        if (wasPublic || isPublic) {
          targets.push({ cache: 'commentPage', patchId: change.patchId })
        }
        // 详情内嵌 comment_count, 资源评论不计入
        if (change.resourceId === null && wasPublic !== isPublic) {
          targets.push({ cache: 'patchContent', patchId: change.patchId })
        }
        break
      }
      case 'rating': {
        const wasPublic = change.before === RATING_STATUS.public
        const isPublic = change.after === RATING_STATUS.public
        // 详情内嵌 ratingSummary: 公开集进出, 或公开评价改了评分
        if (wasPublic !== isPublic || (wasPublic && change.scoreChanged)) {
          targets.push({ cache: 'patchContent', patchId: change.patchId })
        }
        break
      }
      case 'resource': {
        // 资源进出公开集还会改 patch 的 resource_count 与 type / language / platform 聚合,
        // 这些随 recalcPatchType 写进 patch 行, 由执行重算的一方另报 patch 变更。
        // 守卫删除只匹配隐藏或待审的行 (初审拒绝、申诉驳回), 按这里的规则自然不碰公开缓存
        const { touchesPublic, touchesListed, pendingFlip } =
          resourceTransition(change.before, change.after)
        if (touchesPublic) {
          targets.push({ cache: 'resourceDetail', patchId: change.patchId })
        }
        if (touchesListed) {
          targets.push({ cache: 'resourceList' })
        }
        if (pendingFlip) {
          targets.push({ cache: 'pendingResource', uid: change.ownerId })
        }
        break
      }
      case 'resourceReaction':
        // 列表按下载数 / 点赞数排序是跨 patch 的聚合
        targets.push({ cache: 'resourceStatsList' })
        // 资源详情内嵌两个计数, 但只失效点赞: 内嵌的下载数没有界面消费方 (卡片只渲染
        // likeCount, 列表按 sort_order 排序), 而下载是这份缓存最高频的写入。卡片若开始
        // 渲染下载数, 这里要改成两者都失效
        if (change.reaction === 'like') {
          targets.push({ cache: 'resourceDetail', patchId: change.patchId })
        }
        break
      case 'patch':
        targets.push({
          cache: 'patchContent',
          patchId: change.patchId,
          uniqueId: change.uniqueId
        })
        break
      case 'patchDeleted':
        // 详情两键由 URL 里的 uniqueId 构成, 删除后仍可达, 不失效则幽灵详情页活到 TTL;
        // 级联删除关联行时触发器递减标签 / 会社的作品数
        targets.push(
          {
            cache: 'patchContent',
            patchId: change.patchId,
            uniqueId: change.uniqueId
          },
          { cache: 'tagList' },
          { cache: 'companyList' }
        )
        deletedPatchIds.add(change.patchId)
        break
      default: {
        const unreachable: never = change
        throw new Error(`未知的缓存变更: ${JSON.stringify(unreachable)}`)
      }
    }
  }

  const planned = new Map<string, KunCacheTarget>()
  for (const target of targets) {
    // 被删 patch 的资源详情版本键已不可达, 写一个新版本号只会多留一个带 24 小时 TTL 的键
    if (
      target.cache === 'resourceDetail' &&
      deletedPatchIds.has(target.patchId)
    ) {
      continue
    }
    const key = targetKey(target)
    // 同一目标只留一条; 同一 patch 的详情优先留知道 uniqueId 的那条 (不用回库查)
    if (
      !planned.has(key) ||
      (target.cache === 'patchContent' && target.uniqueId !== undefined)
    ) {
      planned.set(key, target)
    }
  }
  return [...planned.values()]
}

// 被共享缓存内嵌、但刻意不精确失效的字段: 写入之后最多陈旧到缓存的 TTL。每个内嵌的跨行字段,
// 要么在上面的规划里有一条边, 要么在这里有一条带理由的记录。accepted 是论证时假定的陈旧上限,
// 把 TTL 调到超过它时 __tests__/plan.test.ts 会变红, 要回来重新论证
//
// 还没有接线、也不是刻意容忍的 (等 T15 S3, 取决于 T25 是否保留补丁详情两键):
//   标签改名 / 删除 → 补丁详情的 tags 与简介的 tag[] (D06-01、X05-01)
//   会社改名 / 删除 → 简介的 company[]
//   删收藏夹 → 补丁详情的收藏数 (D06-02、X05-02; 删号的那一半已由 deleteAccount.ts 的投影失效)
export interface KunTtlTolerance {
  // 缓存的键前缀
  caches: readonly string[]
  field: string
  // 这些缓存里最长的 TTL (秒)
  ttl: number
  accepted: number
  reason: string
}

export const KUN_TTL_TOLERATED: readonly KunTtlTolerance[] = [
  {
    caches: ['patch:<uniqueId>'],
    field: 'view (浏览数)',
    ttl: PATCH_CACHE_DURATION,
    accepted: 300,
    reason:
      '浏览先记进 Redis 缓冲, 由 cron 每 2 分钟刷一次库 (flushPatchViewsTask), 库里的数本来就不是实时的; 每次刷盘失效被浏览过的补丁, 等于让热门补丁的详情缓存形同虚设'
  },
  {
    caches: ['patch:<uniqueId>'],
    field: 'download (补丁的下载数)',
    ttl: PATCH_CACHE_DURATION,
    accepted: 300,
    reason:
      '下载是全站最高频的写入; 详情头部的下载数是展示用的累计数, 晚几分钟不影响任何判断, 每次下载都删一次详情两键会让热门补丁的缓存命中率归零'
  },
  {
    caches: ['patch:resource:detail:<patchId>'],
    field: 'download 与 links[].download (资源与链接的下载数)',
    ttl: PATCH_RESOURCE_DETAIL_CACHE_DURATION,
    accepted: 60,
    reason:
      '没有界面消费方 (资源卡片只渲染 likeCount, 列表按 sort_order 排序); 卡片若开始渲染下载数, 要在上面的 resourceReaction 规则里改成两者都失效'
  },
  {
    caches: ['patch:introduction:<uniqueId>'],
    field: 'tag[].count 与 company[].count (标签 / 会社的作品数)',
    ttl: PATCH_INTRODUCTION_CACHE_DURATION,
    accepted: 300,
    reason:
      '这个数属于共享该标签或会社的全部补丁, 任何一部补丁增删关联都会改它; 精确失效要扇出到全部共享者, 一个热门标签就是几千部补丁'
  },
  {
    caches: [
      'patch:<uniqueId>',
      'patch:comment:*',
      'patch:resource:detail:*',
      'resource:list:*',
      'home:v2:*'
    ],
    field: '作者 / 评论者的 name 与 avatar',
    ttl: Math.max(
      PATCH_CACHE_DURATION,
      COMMENT_CACHE_DURATION,
      PATCH_RESOURCE_DETAIL_CACHE_DURATION,
      RESOURCE_LIST_CACHE_DURATION,
      HOME_CACHE_DURATION
    ),
    accepted: 300,
    reason:
      '改名、换头像 (含头像审核通过) 对单个用户很少发生, 而他的名字内嵌在他建档、评论、发资源的每一部补丁里; 精确失效要先反查全部这些补丁, 晚几分钟换过来可以接受'
  },
  {
    caches: ['patch:resource:detail:*'],
    field: 'user.role (决定资源是否进「官方」分栏)',
    ttl: PATCH_RESOURCE_DETAIL_CACHE_DURATION,
    accepted: 60,
    reason:
      '只在管理员授予或撤销管理员角色时变化, 极少发生; 影响的只是分栏, 不涉及可见性'
  },
  {
    caches: ['patch:resource:detail:*', 'resource:list:*', 'home:v2:*'],
    field: 'user.patchCount 与 patchName (发布者的资源数、补丁名)',
    ttl: Math.max(
      PATCH_RESOURCE_DETAIL_CACHE_DURATION,
      RESOURCE_LIST_CACHE_DURATION,
      HOME_CACHE_DURATION
    ),
    accepted: 60,
    reason:
      '资源数按用户跨补丁计, 在任一补丁下发资源都会改它; 补丁名由编辑改写。两者都只用于展示, 列表与首页的 60 秒 TTL 足够短'
  },
  {
    caches: ['galgame:list:*', 'home:v2:*'],
    field: '作品卡片的全部字段 (计数、评分、浏览数、标签与会社的成员资格)',
    ttl: Math.max(GALGAME_LIST_CACHE_DURATION, HOME_CACHE_DURATION),
    accepted: 60,
    reason:
      '整页列表缓存没有失效入口: 一次写入会落进哪些分页、排序与筛选的组合无法从写路径枚举, 只靠 60 秒 TTL'
  }
]
