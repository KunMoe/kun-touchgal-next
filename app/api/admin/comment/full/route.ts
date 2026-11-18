import { NextRequest, NextResponse } from 'next/server'
import { adminGetFullCommentSchema } from '~/validations/admin'
import { kunParseGetQuery } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { prisma } from '~/prisma/index'
import { can } from '~/constants/permission'

export async function GET(req: NextRequest) {
  const input = kunParseGetQuery(req, adminGetFullCommentSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const comment = await prisma.patch_comment.findUnique({
    where: { id: input.commentId },
    select: { content: true }
  })
  if (!comment) {
    return NextResponse.json('未找到对应的评论')
  }

  return NextResponse.json({ content: comment.content })
}
