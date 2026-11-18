import { NextRequest, NextResponse } from 'next/server'
import { verifyHeaderCookie } from '~/middleware/_verifyHeaderCookie'
import { prisma } from '~/prisma/index'
import { can } from '~/constants/permission'
import type { AdminModerationStats } from '~/types/api/admin'

export const GET = async (req: NextRequest) => {
  const payload = await verifyHeaderCookie(req)
  if (!payload) {
    return NextResponse.json('用户未登录')
  }
  if (!can(payload, 'admin.access')) {
    return NextResponse.json('本页面仅超级管理员可访问')
  }

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  // 状态分布与 token 聚合限定近 30 天, 避免随任务表增长全表扫描
  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  const [todayTotal, statusGroups, tokenAgg] = await Promise.all([
    prisma.moderation_task.count({
      where: { created: { gte: todayStart } }
    }),
    prisma.moderation_task.groupBy({
      by: ['status'],
      where: { created: { gte: windowStart } },
      _count: { _all: true }
    }),
    prisma.moderation_task.aggregate({
      where: { created: { gte: windowStart } },
      _sum: { tokens_in: true, tokens_out: true }
    })
  ])

  const stats: AdminModerationStats = {
    todayTotal,
    statusCounts: Object.fromEntries(
      statusGroups.map((group) => [group.status, group._count._all])
    ),
    tokensIn: tokenAgg._sum.tokens_in ?? 0,
    tokensOut: tokenAgg._sum.tokens_out ?? 0
  }

  return NextResponse.json(stats)
}
