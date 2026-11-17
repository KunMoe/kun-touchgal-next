import type { PatchComment } from '~/types/api/patch'

// 楼中楼的折叠与分页 (参考贴吧 PC 楼中楼): 默认只露出前 REPLY_COLLAPSED_COUNT 条,
// 展开后每页 REPLY_PAGE_SIZE 条。纯展示层: 回复仍随根评论一次下发
// (get.ts 把整棵子树摊平进 reply), 这里只决定渲染其中哪一段
export const REPLY_COLLAPSED_COUNT = 3
export const REPLY_PAGE_SIZE = 10
// 展开到末页: 页码由 resolveReplyView 钳到实际页数, 此后回复再增删也仍停在末页
export const REPLY_LAST_PAGE = Infinity

export interface ReplyViewState {
  expanded: boolean
  page: number
}

// 以根评论 id 为键; 缺席即默认折叠
export type ReplyViewMap = Record<number, ReplyViewState>

// 页码在这里钳到有效范围而不是在写入状态时: 删回复会让总页数缩水,
// 回复删到不超过预览条数时整楼退回不折叠
export const resolveReplyView = (replyCount: number, view?: ReplyViewState) => {
  const foldable = replyCount > REPLY_COLLAPSED_COUNT
  if (!foldable || !view?.expanded) {
    return {
      foldable,
      expanded: false,
      page: 1,
      pageCount: 1,
      start: 0,
      end: foldable ? REPLY_COLLAPSED_COUNT : replyCount
    }
  }

  const pageCount = Math.ceil(replyCount / REPLY_PAGE_SIZE)
  const page = Math.min(Math.max(1, view.page), pageCount)
  const start = (page - 1) * REPLY_PAGE_SIZE
  return {
    foldable,
    expanded: true,
    page,
    pageCount,
    start,
    end: start + REPLY_PAGE_SIZE
  }
}

// pinnedReplyId: 正开着内联回复框的那条回复。它不在当前切片里也保持挂载 (仍按原顺序排),
// 否则翻页 / 收起会把回复框连同没发出去的草稿一起卸载
export const getVisibleReplies = (
  replies: PatchComment[],
  view?: ReplyViewState,
  pinnedReplyId?: number | null
) => {
  const { start, end } = resolveReplyView(replies.length, view)
  return replies.filter(
    (reply, index) =>
      (index >= start && index < end) || reply.id === pinnedReplyId
  )
}

// 让目标评论可见所需的展开状态。目标是根评论、不在本页、或已落在折叠预览内时
// 无需展开, 返回空表
export const locateReplyViews = (
  comments: PatchComment[],
  commentId: number
): ReplyViewMap => {
  for (const comment of comments) {
    const index = comment.reply.findIndex((reply) => reply.id === commentId)
    if (index >= REPLY_COLLAPSED_COUNT) {
      return {
        [comment.id]: {
          expanded: true,
          page: Math.floor(index / REPLY_PAGE_SIZE) + 1
        }
      }
    }
  }
  return {}
}
