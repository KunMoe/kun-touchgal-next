import { prisma } from '~/prisma'
import { defineScheduledJob } from '~/server/jobs/registry'
import { invalidateAllUserSessions } from '~/app/api/user/session/cache'

export const resetDailyStats = async () => {
  // 只重写三列任一非 0 的行: 无 where 会把全表 (数十万行, 绝大多数本就为 0) 逐行重写,
  // 且 updateMany 会注入 @updatedAt, 让每个用户的 updated 都被推到每天 0 点.
  // 用 not: 0 而非 gt: 0, 以便历史或未来出现的负值也能被清零.
  await prisma.user.updateMany({
    where: {
      OR: [
        { daily_image_count: { not: 0 } },
        { daily_check_in: { not: 0 } },
        { daily_upload_size: { not: 0 } }
      ]
    },
    data: {
      daily_image_count: 0,
      daily_check_in: 0,
      daily_upload_size: 0
    }
  })
  await invalidateAllUserSessions()
}

// 每天的 0 点只重置一次: 部署时新旧两个 cron 进程短暂并存也只有一个执行。标记键沿用原来那把
// 不释放的锁的键名, 与还没升级的进程照样互斥。没抢到 (Redis 连续出错) 这一天就不重置, 与
// 原来相同
export const resetDailyJob = defineScheduledJob({
  name: 'reset_daily',
  schedule: '0 0 * * *',
  slotMarker: { key: 'cron:reset-daily:lock', ttlSeconds: 60 * 60 },
  run: () => resetDailyStats()
})
