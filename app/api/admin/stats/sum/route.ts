import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { prisma } from '~/prisma/index'
import { can } from '~/constants/permission'
import type { SumData } from '~/types/api/admin'

const getSumData = async (): Promise<SumData> => {
  const [
    userCount,
    galgameCount,
    galgameResourceCount,
    galgamePatchResourceCount,
    galgameCommentCount
  ] = await Promise.all([
    prisma.user.count(),
    prisma.patch.count(),
    prisma.patch_resource.count({
      where: { section: 'galgame' }
    }),
    prisma.patch_resource.count({
      where: { section: 'patch' }
    }),
    prisma.patch_comment.count()
  ])

  return {
    userCount,
    galgameCount,
    galgameResourceCount,
    galgamePatchResourceCount,
    galgameCommentCount
  }
}

export const GET = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const data = await getSumData()
  return NextResponse.json(data)
}
