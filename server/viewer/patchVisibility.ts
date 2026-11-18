import { buildBlockedTagWhere } from '~/utils/blockedTag'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { KunViewer } from '~/app/api/utils/contentVisibility'

export type ContentLimit = 'sfw' | 'nsfw'

// 一个请求能看到哪些作品。contentLimit 为 null 表示不按分级过滤
export interface PatchVisibility {
  readonly contentLimit: ContentLimit | null
  readonly blockedTagIds: readonly number[]
}

// 未登录或会话无效的视角: 与客户端带来的设置 cookie 无关
export const PUBLIC_VISIBILITY: PatchVisibility = {
  contentLimit: 'sfw',
  blockedTagIds: []
}

export const toPatchWhere = (
  visibility: PatchVisibility
): Prisma.patchWhereInput => ({
  ...(visibility.contentLimit
    ? { content_limit: visibility.contentLimit }
    : {}),
  ...buildBlockedTagWhere(visibility.blockedTagIds)
})

// Meilisearch 过滤条件要的原始值, 与 toPatchWhere 表达同一个视角
export const toSearchVisibility = (visibility: PatchVisibility) =>
  ({
    contentLimit: visibility.contentLimit,
    blockedTagIds: [...visibility.blockedTagIds]
  }) satisfies Record<keyof PatchVisibility, unknown>

type UnblockedVisibility = PatchVisibility & {
  readonly blockedTagIds: readonly []
}

// 列表类响应的三种视角:
// shared   与具体用户无关, 可读写共享缓存。类型上没有 viewer, 屏蔽标签只能是空的
// filtered 带屏蔽标签: 屏蔽标签取自客户端的镜像 cookie, 进了键就是每个子集各铸一个键,
//          键的数量由客户端输入决定, 所以不读不写共享缓存; 内容仍按公开基线查询
// personal 能看到待审核内容的用户 (管理员, 或有待审核资源的作者): 响应因人而异, 不进共享缓存
// 这些约束防的是写错, 不是安全边界: 结构类型拦不住多带一个字段的对象, 也拦不住构造之后
// 再去改数组。视角一律由 ViewerContext.listView() 给出, 不要手写
export type ListView =
  | { readonly kind: 'shared'; readonly visibility: UnblockedVisibility }
  | { readonly kind: 'filtered'; readonly visibility: PatchVisibility }
  | {
      readonly kind: 'personal'
      readonly visibility: PatchVisibility
      readonly viewer: KunViewer
    }

export type PublicListView = Exclude<ListView, { kind: 'personal' }>

const isUnblocked = (
  visibility: PatchVisibility
): visibility is UnblockedVisibility => visibility.blockedTagIds.length === 0

export const toPublicListView = (
  visibility: PatchVisibility
): PublicListView =>
  isUnblocked(visibility)
    ? { kind: 'shared', visibility }
    : { kind: 'filtered', visibility }

// 共享缓存键里的视角段。只收 shared 视角, 并且从它自己的 visibility 现算: 键与查询条件
// (toPatchWhere(view.visibility)) 出自同一个值, 视角上没有可以另填的键字段。
// parts 逐字段列出 PatchVisibility (多了字段而这里没跟上, satisfies 让编译失败),
// 再把每一段都拼进去, 所以新的可见性维度既漏不掉声明, 也漏不掉进键
export const toCacheVariant = (view: Extract<ListView, { kind: 'shared' }>) => {
  const parts = {
    contentLimit: view.visibility.contentLimit ?? 'all',
    blockedTagIds: ''
  } satisfies Record<keyof PatchVisibility, string>
  return Object.values(parts).join(':')
}
