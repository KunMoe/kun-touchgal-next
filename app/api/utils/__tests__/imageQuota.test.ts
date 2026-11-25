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
  DAILY_IMAGE_QUOTA_EXHAUSTED,
  claimDailyImageQuota,
  refundDailyImageQuota,
  withDailyImageQuota
} from '../imageQuota'
import { ImageRejection } from '~/server/image/pipeline'

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

describe('withDailyImageQuota', () => {
  const claimed = () =>
    updateManyMock.mock.calls.filter(
      ([args]) => args.data.daily_image_count.increment === 1
    ).length
  const refunded = () =>
    updateManyMock.mock.calls.filter(
      ([args]) => args.data.daily_image_count.decrement === 1
    ).length

  beforeEach(() => {
    updateManyMock.mockReset()
    updateManyMock.mockResolvedValue({ count: 1 })
  })

  it('成功: 额度落定, 原样返回 work 的结果', async () => {
    expect(await withDailyImageQuota(7, async () => 'ok' as const)).toBe('ok')
    expect([claimed(), refunded()]).toEqual([1, 0])
  })

  it('抢不到: 返回限额文案, 不调 work', async () => {
    updateManyMock.mockResolvedValue({ count: 0 })
    const work = vi.fn()

    expect(await withDailyImageQuota(7, work)).toBe(DAILY_IMAGE_QUOTA_EXHAUSTED)
    expect(DAILY_IMAGE_QUOTA_EXHAUSTED).toContain(String(DAILY_IMAGE_LIMIT))
    expect(work).not.toHaveBeenCalled()
  })

  it('不计费的拒绝 (排队忙) 退还, 计费的 (解码失败、超限) 不退, 都返回文案', async () => {
    expect(
      await withDailyImageQuota(7, async () => new ImageRejection('忙', false))
    ).toBe('忙')
    expect([claimed(), refunded()]).toEqual([1, 1])

    updateManyMock.mockClear()
    expect(
      await withDailyImageQuota(7, async () => new ImageRejection('坏图', true))
    ).toBe('坏图')
    expect([claimed(), refunded()]).toEqual([1, 0])
  })

  it('不计费的拒绝退还失败时照样返回文案', async () => {
    updateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db down'))

    expect(
      await withDailyImageQuota(7, async () => new ImageRejection('忙', false))
    ).toBe('忙')
  })

  it('work 抛错: 退还后原样抛出, 退还自己失败不盖住原始错误', async () => {
    updateManyMock
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db down'))

    await expect(
      withDailyImageQuota(7, async () => {
        throw new Error('s3 down')
      })
    ).rejects.toThrow('s3 down')
    expect([claimed(), refunded()]).toEqual([1, 1])
  })
})
