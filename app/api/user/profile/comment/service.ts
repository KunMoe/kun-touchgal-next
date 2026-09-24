import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { getUserInfoSchema } from '~/validations/user'
import { markdownToText } from '~/utils/markdownToText'
import { PatchRefSelectField } from '~/constants/api/select'
import {
  getCommentRatingVisibilityWhere,
  isContentVisibleToViewer,
  type KunViewer
} from '~/app/api/utils/contentVisibility'
import type { UserComment } from '~/types/api/user'

export const getUserComment = async (
  input: z.infer<typeof getUserInfoSchema>,
  viewer: KunViewer
) => {
  const { uid, page, limit } = input
  const offset = (page - 1) * limit
  const visibilityWhere = getCommentRatingVisibilityWhere(viewer)

  const [data, total] = await Promise.all([
    prisma.patch_comment.findMany({
      where: { user_id: uid, ...visibilityWhere },
      select: {
        id: true,
        content: true,
        user_id: true,
        patch_id: true,
        resource_id: true,
        created: true,
        patch: { select: PatchRefSelectField },
        parent: {
          select: {
            status: true,
            user_id: true,
            user: { select: { name: true } }
          }
        },
        _count: { select: { like_by: true } }
      },
      orderBy: { created: 'desc' },
      take: limit,
      skip: offset
    }),
    prisma.patch_comment.count({
      where: { user_id: uid, ...visibilityWhere }
    })
  ])

  const comments: UserComment[] = data.map((comment) => {
    // 父评论待审核 (status=1) 时仅对作者与管理员显示引用信息; 隐藏 (status=2) 时对所有人隐藏
    const parentVisible =
      !!comment.parent &&
      (comment.parent.status === 0 ||
        (comment.parent.status === 1 &&
          isContentVisibleToViewer(viewer, comment.parent.user_id)))

    return {
      id: comment.id,
      patchUniqueId: comment.patch.unique_id,
      content: markdownToText(comment.content).slice(0, 233),
      like: comment._count.like_by,
      userId: comment.user_id,
      patchId: comment.patch_id,
      resourceId: comment.resource_id,
      patchName: comment.patch.name,
      created: String(comment.created),
      quotedUserUid: parentVisible ? comment.parent?.user_id : undefined,
      quotedUsername: parentVisible ? comment.parent?.user.name : undefined
    }
  })

  return { comments, total }
}
