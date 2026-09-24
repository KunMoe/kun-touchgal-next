import * as z from 'zod'
import { NextRequest, NextResponse } from 'next/server'
import { kunParsePostBody } from '~/app/api/utils/parseQuery'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { createPatchRatingReportSchema } from '~/validations/patch'
import { prisma } from '~/prisma'

const createReport = async (
  input: z.infer<typeof createPatchRatingReportSchema>,
  uid: number
) => {
  const rating = await prisma.patch_rating.findUnique({
    where: { id: input.ratingId },
    select: {
      id: true,
      user_id: true,
      patch_id: true,
      status: true
    }
  })
  if (!rating) {
    return '评价不存在'
  }
  if (rating.patch_id !== input.patchId) {
    return '评价不属于当前游戏'
  }
  if (rating.user_id === uid) {
    return '不能举报自己的评价'
  }
  // 待审核 (status=1) 的评价不可举报; 隐藏 (status=2) 的评价前端不可见, 与不存在等同
  if (rating.status === 1) {
    return '该评价正在审核中, 暂时无法举报'
  }
  if (rating.status !== 0) {
    return '评价不存在'
  }

  const existingReport = await prisma.patch_report.findFirst({
    where: {
      target_type: 'rating',
      rating_id: rating.id,
      sender_id: uid,
      status: 0
    },
    select: { id: true }
  })
  if (existingReport) {
    return '您已经举报过该评价，请等待管理员处理'
  }

  await prisma.patch_report.create({
    data: {
      target_type: 'rating',
      reason: input.content,
      sender_id: uid,
      reported_user_id: rating.user_id,
      patch_id: rating.patch_id,
      rating_id: rating.id
    }
  })

  return {}
}

export const POST = async (req: NextRequest) => {
  const input = await kunParsePostBody(req, createPatchRatingReportSchema)
  if (typeof input === 'string') {
    return NextResponse.json(input)
  }
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }

  const response = await createReport(input, payload.uid)
  return NextResponse.json(response)
}
