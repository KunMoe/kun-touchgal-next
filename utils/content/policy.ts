// 评论、评价、资源在前台「谁能看、谁能动」的唯一规则表。纯函数, 前后端同构 (只依赖
// constants/); 入口的事务外预检、交给命令的守卫数据、行锁下被跳过时的文案、读侧的可见性
// 谓词 (server/content/visibility.ts) 都从这里推导, 改规则只改这一个文件。
// 后台 (/admin) 的管理入口不走这里: 它们能动任何状态的内容, 守卫由入口直接给。
import { can } from '~/constants/permission'
import {
  contentPhase,
  isPendingPhase,
  statusesOf
} from '~/constants/contentStatus'
import type {
  ContentKind,
  ContentPhase,
  ContentStatusOf
} from '~/constants/contentStatus'
import type { KunSubject } from '~/constants/role'
import type { ContentGuard, SkippedContent } from '~/server/content/guard'

export type ContentViewer = KunSubject

// like / report / reply 是对别人内容的互动: 管理员不豁免。edit / delete 是对内容本身的处置:
// 作者本人或有 content.moderateAny 能力的人才可以
export type ContentAction = 'like' | 'report' | 'reply' | 'edit' | 'delete'

export type ContentDenyReason =
  'not_found' | 'self' | 'forbidden' | 'pending' | 'awaiting_approval'

interface DenyMessages {
  not_found: string
  pending: string
  self?: string
  forbidden?: string
  // 没写时用 pending 的文案
  awaiting_approval?: string
}

// 文案逐字沿用各入口原有的写法 (「未找到评论」与「评论不存在」这类不一致照旧, 文案统一不在这里做)
export const CONTENT_DENY_MESSAGE = {
  comment: {
    like: {
      not_found: '未找到评论',
      self: '您不能给自己点赞',
      pending: '该评论正在审核中, 暂时无法点赞'
    },
    report: {
      not_found: '评论不存在',
      self: '不能举报自己的评论',
      pending: '该评论正在审核中, 暂时无法举报'
    },
    reply: {
      not_found: '未找到该评论',
      pending: '该评论正在审核中, 暂时无法回复'
    },
    edit: {
      not_found: '未找到该评论',
      forbidden: '您没有权限更改该评论',
      pending: '您发布的评论正在审核中, 暂时无法修改'
    },
    delete: {
      not_found: '未找到对应的评论',
      forbidden: '您没有权限删除该评论',
      pending: '该评论正在审核中, 暂时无法删除'
    }
  },
  rating: {
    like: {
      not_found: '评价不存在',
      self: '您不能给自己点赞',
      pending: '该评价正在审核中, 暂时无法点赞'
    },
    report: {
      not_found: '评价不存在',
      self: '不能举报自己的评价',
      pending: '该评价正在审核中, 暂时无法举报'
    },
    edit: {
      not_found: '评价不存在',
      forbidden: '您没有权限更新该评价',
      pending: '您发布的评价正在审核中, 暂时无法修改'
    },
    delete: {
      not_found: '评价不存在',
      forbidden: '您没有权限删除该评价',
      pending: '该评价正在审核中, 暂时无法删除'
    }
  },
  resource: {
    like: {
      not_found: '未找到资源',
      self: '您不能给自己点赞',
      pending: '该资源正在审核中, 暂时无法点赞'
    },
    edit: {
      not_found: '未找到该资源',
      forbidden: '您没有权限更改该资源',
      pending: '您发布的资源正在审核中, 暂时无法修改',
      awaiting_approval: '您发布的资源正在等待管理员审核, 暂时无法修改'
    },
    delete: {
      not_found: '未找到对应的资源',
      forbidden: '您没有权限删除该资源',
      pending: '该资源正在审核中, 暂时无法删除'
    }
  }
} as const satisfies Record<
  ContentKind,
  Partial<Record<ContentAction, DenyMessages>>
>

type Messages = typeof CONTENT_DENY_MESSAGE
export type ContentActionOf<K extends ContentKind> = keyof Messages[K] &
  ContentAction

// K 是泛型时 TS 索引不出具体的那张文案表; 动作是否属于该 kind 已由 ContentActionOf 在调用点检查
const messagesOf = <K extends ContentKind>(
  kind: K,
  action: ContentActionOf<K>
) =>
  (CONTENT_DENY_MESSAGE[kind] as Partial<Record<ContentAction, DenyMessages>>)[
    action
  ] as DenyMessages

const deny = (messages: DenyMessages, reason: ContentDenyReason) => ({
  ok: false as const,
  reason,
  message:
    messages[reason] ??
    (reason === 'awaiting_approval' ? messages.pending : messages.not_found)
})

const isOwner = (row: { user_id: number }, viewer: ContentViewer | null) =>
  !!viewer && viewer.uid > 0 && row.user_id === viewer.uid

// 待审 (含资源的待初审) 只给作者本人与有 content.viewPending 能力的人看; 隐藏对前台所有人都
// 不可见, 管理员也不例外 (只在 /admin 管理)
export const visiblePhases = (
  viewer: ContentViewer | null,
  owner: boolean
): readonly ContentPhase[] =>
  owner || can(viewer, 'content.viewPending')
    ? ['public', 'pending', 'awaitingApproval']
    : ['public']

export const isContentVisible = (
  kind: ContentKind,
  row: { status: number; user_id: number },
  viewer: ContentViewer | null
) =>
  visiblePhases(viewer, isOwner(row, viewer)).includes(
    contentPhase(kind, row.status)
  )

// 评论区随所属资源关闭: 资源对 viewer 不可见时, 它下面的评论按不存在处理。游戏评论区
// (没有所属资源) 不受影响
export const isCommentContainerVisible = (
  resource: { status: number; user_id: number } | null | undefined,
  viewer: ContentViewer | null
) => !resource || isContentVisible('resource', resource, viewer)

// 不能处置他人内容的人, 内容有在途审核任务时也不能编辑 (送审快照会与实际内容脱节)。
// 入口据此决定要不要去查在途任务
export const pendingTaskBlocks = (viewer: ContentViewer | null) =>
  !can(viewer, 'content.moderateAny')

export type ContentDecision<R> =
  | { ok: true; row: R }
  | { ok: false; reason: ContentDenyReason; message: string }

// 入口在事务外快照上的判定。row 为 null 表示行不存在。
// pendingTask: 编辑时内容有在途审核任务 (只对 pendingTaskBlocks 的人有意义)。
// containerVisible: 评论所属的资源对 viewer 不可见时传 false, 评论区随之关闭 (按不存在处理)
export const decideContentAction = <
  K extends ContentKind,
  R extends { status: number; user_id: number }
>(
  kind: K,
  row: R | null,
  viewer: ContentViewer | null,
  action: ContentActionOf<K>,
  options: { pendingTask?: boolean; containerVisible?: boolean } = {}
): ContentDecision<R> => {
  const messages = messagesOf(kind, action)
  if (!row || options.containerVisible === false) {
    return deny(messages, 'not_found')
  }
  const phase = contentPhase(kind, row.status)
  const owner = isOwner(row, viewer)

  if (action === 'like' || action === 'report' || action === 'reply') {
    if (action !== 'reply' && owner) {
      return deny(messages, 'self')
    }
    if (isPendingPhase(phase)) {
      return deny(messages, 'pending')
    }
    return phase === 'public' ? { ok: true, row } : deny(messages, 'not_found')
  }

  if (phase === 'hidden') {
    return deny(messages, 'not_found')
  }
  const moderator = can(viewer, 'content.moderateAny')
  if (!owner && !moderator) {
    return deny(messages, 'forbidden')
  }
  if (!moderator) {
    if (phase === 'awaitingApproval') {
      return deny(messages, 'awaiting_approval')
    }
    if (isPendingPhase(phase) || (action === 'edit' && options.pendingTask)) {
      return deny(messages, 'pending')
    }
  }
  return { ok: true, row }
}

// 编辑 / 删除交给命令的守卫: 命令在行锁下用它复检, 与 decideContentAction 的判定等价
// (policy.test.ts 逐格核对)。管理员能动公开与待审的, 其余人只能动自己公开的
export const contentGuard = <K extends ContentKind>(
  kind: K,
  viewer: ContentViewer
): ContentGuard<ContentStatusOf<K>> =>
  can(viewer, 'content.moderateAny')
    ? { statusIn: statusesOf(kind, ['public', 'pending', 'awaitingApproval']) }
    : { statusIn: statusesOf(kind, ['public']), ownerUid: viewer.uid }

// 行锁下被守卫跳过的行 → 文案, 与预检在同一状态上给出的文案相同
export const contentSkipMessage = <K extends ContentKind>(
  kind: K,
  action: ContentActionOf<K>,
  skipped: SkippedContent<number>
) => {
  const messages = messagesOf(kind, action)
  if (skipped.reason === 'gone') {
    return deny(messages, 'not_found').message
  }
  if (skipped.reason === 'owner') {
    return deny(messages, 'forbidden').message
  }
  const phase = contentPhase(kind, skipped.status)
  if (phase === 'awaitingApproval') {
    return deny(messages, 'awaiting_approval').message
  }
  return deny(messages, isPendingPhase(phase) ? 'pending' : 'not_found').message
}
