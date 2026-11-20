import { kunRoute } from '~/app/api/utils/kunRoute'
import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { readModerationHealth } from '~/server/moderation/health'
import type { AdminModerationStats } from '~/types/api/admin'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  handler: async () => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    // 状态分布与 token 聚合限定近 30 天, 避免随任务表增长全表扫描
    const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

    const [
      todayTotal,
      statusGroups,
      tokenAgg,
      oldestPending,
      manualKindGroups,
      manualUnsure,
      worker
    ] = await Promise.all([
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
      }),
      // 下面两项看的是仍然挂着的任务, 不限 30 天: 待审核与转人工的行很少, 走
      // [status, next_attempt] 索引。车道被暂停时任务不转人工而是留在待审核, 所以
      // 「最早一条等了多久」是队列有没有在动的直接信号
      prisma.moderation_task.aggregate({
        where: { status: 'pending' },
        _min: { created: true }
      }),
      prisma.moderation_task.groupBy({
        by: ['failure_kind'],
        where: { status: 'manual' },
        _count: { _all: true }
      }),
      // 没有失败类别的转人工任务分两种: 有裁决的是 AI 拿不准 (m=1); 没有裁决的是
      // 引入失败类别之前转人工的, 原因只在 reject_reason 里
      prisma.moderation_task.count({
        where: {
          status: 'manual',
          failure_kind: '',
          verdict: { not: Prisma.DbNull }
        }
      }),
      readModerationHealth()
    ])

    const stats: AdminModerationStats = {
      todayTotal,
      statusCounts: Object.fromEntries(
        statusGroups.map((group) => [group.status, group._count._all])
      ),
      tokensIn: tokenAgg._sum.tokens_in ?? 0,
      tokensOut: tokenAgg._sum.tokens_out ?? 0,
      worker,
      oldestPendingAt: oldestPending._min.created,
      manualKindCounts: Object.fromEntries(
        manualKindGroups
          .filter((group) => group.failure_kind)
          .map((group) => [group.failure_kind, group._count._all])
      ),
      manualUnsureCount: manualUnsure,
      manualUnclassifiedCount:
        (manualKindGroups.find((group) => !group.failure_kind)?._count._all ??
          0) - manualUnsure
    }

    return stats
  }
})
