import type { PatchComment } from '~/types/api/patch'

// 把点赞接口返回的结果写回评论树 (根与回复两层, 同 removeComment)。
// 点赞状态若只留在按钮本地, 楼中楼翻页 / 收起把回复卸载再挂载时会被旧 props 冲掉:
// 界面显示未赞而服务端已赞, 再点一次就成了取消。
// 计数按「状态是否真的翻转」增减, 接口返回的结果与本地一致时不重复计
const applyLike = (comment: PatchComment, isLike: boolean): PatchComment =>
  comment.isLike === isLike
    ? comment
    : {
        ...comment,
        isLike,
        likeCount: comment.likeCount + (isLike ? 1 : -1)
      }

export const updateCommentLike = (
  prev: PatchComment[],
  commentId: number,
  isLike: boolean
) =>
  prev.map((comment) => {
    if (comment.id === commentId) {
      return applyLike(comment, isLike)
    }
    if (!comment.reply.some((reply) => reply.id === commentId)) {
      return comment
    }
    return {
      ...comment,
      reply: comment.reply.map((reply) =>
        reply.id === commentId ? applyLike(reply, isLike) : reply
      )
    }
  })
