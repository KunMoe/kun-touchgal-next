import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma/index'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import {
  getCommentRatingVisibilityWhere,
  type KunViewer
} from '~/app/api/utils/contentVisibility'

const commentIdSchema = z.object({
  commentId: z.coerce
    .number({ message: '评论 ID 必须为数字' })
    .min(1)
    .max(9999999)
})

const getCommentMarkdown = async (
  input: z.infer<typeof commentIdSchema>,
  viewer: KunViewer
) => {
  const { commentId } = input

  const comment = await prisma.patch_comment.findFirst({
    where: { id: commentId, ...getCommentRatingVisibilityWhere(viewer) },
    select: {
      content: true,
      is_spoiler: true
    }
  })

  return {
    content: comment?.content ?? '',
    isSpoiler: comment?.is_spoiler ?? false
  }
}

export const GET = async (req: NextRequest) => {
  const input = kunParseGetQuery(req, commentIdSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await getCommentMarkdown(input, payload)
  return NextResponse.json(response)
}
