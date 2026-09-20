import { prisma } from '~/prisma'
import cron from 'node-cron'
import { withTaskLock } from './withTaskLock'
import { invalidateAllUserSessions } from '~/app/api/user/session/cache'

const RESET_DAILY_LOCK_KEY = 'cron:reset-daily:lock'
const RESET_DAILY_LOCK_TTL_SECONDS = 60 * 60

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

export const resetDailyTask = cron.createTask('0 0 * * *', async () => {
  await withTaskLock(
    {
      key: RESET_DAILY_LOCK_KEY,
      ttlSeconds: RESET_DAILY_LOCK_TTL_SECONDS,
      taskName: 'resetDailyTask',
      releaseOnComplete: false
    },
    resetDailyStats
  )
})
