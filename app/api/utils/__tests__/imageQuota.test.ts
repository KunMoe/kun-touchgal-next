import { beforeEach, describe, expect, it, vi } from 'vitest'

const { updateManyMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { updateMany: updateManyMock }
  }
}))

import {
  DAILY_IMAGE_LIMIT,
  claimDailyImageQuota,
  refundDailyImageQuota
} from '../imageQuota'

describe('claimDailyImageQuota', () => {
  beforeEach(() => {
    updateManyMock.mockReset()
  })

  it('把 "计数 < 上限" 判定下推到 DB 单条写, +1 并返回 true', async () => {
    updateManyMock.mockResolvedValue({ count: 1 })

    const ok = await claimDailyImageQuota(7)

    expect(ok).toBe(true)
    // where 携带 lt 上限 = 原子性的证据: 判定与递增合并为一次写, 而非应用层 read-then-write
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 7, daily_image_count: { lt: DAILY_IMAGE_LIMIT } },
      data: { daily_image_count: { increment: 1 } }
    })
  })

  it('已达上限时 0 行受影响, 返回 false 且不放行', async () => {
    updateManyMock.mockResolvedValue({ count: 0 })

    const ok = await claimDailyImageQuota(7)

    expect(ok).toBe(false)
  })
})

describe('refundDailyImageQuota', () => {
  beforeEach(() => {
    updateManyMock.mockReset()
  })

  it('对称退还一个额度 (decrement), 且 where 携带下限守卫', async () => {
    updateManyMock.mockResolvedValue({ count: 1 })

    await refundDailyImageQuota(7)

    // where 携带 gte: 1 = 下限守卫的证据: 抢占若已被日重置 / 管理员下调吞掉,
    // 退还必须 0 行受影响, 而非把计数减成负数
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 7, daily_image_count: { gte: 1 } },
      data: { daily_image_count: { decrement: 1 } }
    })
  })

  it('抢占已被日重置 / 管理员下调吞掉时 0 行受影响, 静默返回不抛错', async () => {
    updateManyMock.mockResolvedValue({ count: 0 })

    await expect(refundDailyImageQuota(7)).resolves.toBeUndefined()
  })
})
