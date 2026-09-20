import { beforeEach, describe, expect, it, vi } from 'vitest'

const { updateManyMock, invalidateAllUserSessionsMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(),
  invalidateAllUserSessionsMock: vi.fn()
}))

vi.mock('~/prisma', () => ({
  prisma: { user: { updateMany: updateManyMock } }
}))

// resetDailyTask 经 withTaskLock 间接 import ~/lib/redis，mock 掉避免真实连接
vi.mock('~/lib/redis', () => ({
  acquireKvLock: vi.fn(),
  releaseKvLock: vi.fn(),
  renewKvLock: vi.fn()
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateAllUserSessions: invalidateAllUserSessionsMock
}))

import { resetDailyStats } from '~/server/tasks/resetDailyTask'

describe('resetDailyStats 只重写三列任一非 0 的行', () => {
  beforeEach(() => {
    updateManyMock.mockReset().mockResolvedValue({ count: 0 })
    invalidateAllUserSessionsMock.mockReset().mockResolvedValue(undefined)
  })

  it('updateMany 带 where.OR 三条 not:0，不全表重写、不污染 @updatedAt', async () => {
    await resetDailyStats()

    expect(updateManyMock).toHaveBeenCalledTimes(1)
    expect(updateManyMock).toHaveBeenCalledWith({
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
  })

  it('清零落库之后才失效全部会话缓存', async () => {
    await resetDailyStats()

    expect(invalidateAllUserSessionsMock).toHaveBeenCalledTimes(1)
    expect(updateManyMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateAllUserSessionsMock.mock.invocationCallOrder[0]
    )
  })
})
