import { beforeEach, describe, expect, it, vi } from 'vitest'

const { randomMock } = vi.hoisted(() => ({ randomMock: vi.fn() }))
vi.mock('~/utils/random', () => ({ randomNormalInt: randomMock }))

import {
  adjustPoints,
  claimCheckIn,
  creditGalgamePublish,
  creditPoints,
  reverseCredit,
  revokeCredits,
  spendOnConversation,
  spendOnRename
} from '~/server/points/account'
import type { Prisma } from '~/prisma/generated/prisma/client'

// 只记录发出的 Prisma 调用: 守卫与融合列必须在同一条语句的 where / data 里
const db = {
  user: { update: vi.fn(), updateMany: vi.fn() },
  $executeRaw: vi.fn()
}
const tx = db as unknown as Prisma.TransactionClient

beforeEach(() => {
  vi.resetAllMocks()
  db.user.update.mockResolvedValue({ moemoepoint: 0 })
  db.user.updateMany.mockResolvedValue({ count: 1 })
})

describe('无守卫的发放与收回', () => {
  it.each([
    ['resource_publish', 3],
    ['like_received', 1]
  ] as const)('creditPoints %s 加 %i', async (reason, credit) => {
    await creditPoints(tx, 7, reason)

    expect(db.user.update.mock.calls).toEqual([
      [{ where: { id: 7 }, data: { moemoepoint: { increment: credit } } }]
    ])
  })

  it('取消点赞收回 1, 不设下限', async () => {
    await reverseCredit(tx, 7, 'like_received')

    expect(db.user.update.mock.calls).toEqual([
      [{ where: { id: 7 }, data: { moemoepoint: { increment: -1 } } }]
    ])
  })

  it('发布 Galgame: 奖励与当日图片计数是同一条 UPDATE', async () => {
    await creditGalgamePublish(tx, 7)

    expect(db.user.update.mock.calls).toEqual([
      [
        {
          where: { id: 7 },
          data: {
            daily_image_count: { increment: 1 },
            moemoepoint: { increment: 3 }
          }
        }
      ]
    ])
  })
})

describe('有守卫的领取与扣费 (平铺 WHERE 的条件更新)', () => {
  it('签到: 按规则表的区间取数, 标记与加分同一条语句', async () => {
    randomMock.mockReturnValue(5)

    await expect(claimCheckIn(tx, 7)).resolves.toEqual({
      claimed: true,
      amount: 5
    })
    expect(randomMock).toHaveBeenCalledWith(2, 7)
    expect(db.user.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 7, daily_check_in: 0 },
          data: {
            moemoepoint: { increment: 5 },
            daily_check_in: { set: 1 }
          }
        }
      ]
    ])
  })

  it('签到: 今天已领过 (count 0) 时 claimed 为 false', async () => {
    db.user.updateMany.mockResolvedValue({ count: 0 })

    expect((await claimCheckIn(tx, 7)).claimed).toBe(false)
  })

  it('改名: 余额守卫用门槛, name 守卫防重复扣, 改名与扣费同一条语句', async () => {
    await expect(spendOnRename(tx, 7, 'kun')).resolves.toBe(true)

    expect(db.user.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 7, moemoepoint: { gte: 30 }, name: { not: 'kun' } },
          data: { name: 'kun', moemoepoint: { increment: -30 } }
        }
      ]
    ])
  })

  it('私聊: 守卫用门槛 20, 扣价格 10', async () => {
    await expect(spendOnConversation(tx, 7)).resolves.toBe(true)

    expect(db.user.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: 7, moemoepoint: { gte: 20 } },
          data: { moemoepoint: { decrement: 10 } }
        }
      ]
    ])
  })

  it.each([
    ['改名', () => spendOnRename(tx, 7, 'kun')],
    ['私聊', () => spendOnConversation(tx, 7)]
  ])('%s: 守卫落空 (count 0) 返回 false', async (_name, spend) => {
    db.user.updateMany.mockResolvedValue({ count: 0 })

    await expect(spend()).resolves.toBe(false)
  })
})

describe('后台调分', () => {
  it('按差值写, 返回写后的余额', async () => {
    db.user.update.mockResolvedValue({ moemoepoint: -4 })

    await expect(adjustPoints(tx, 7, -24)).resolves.toBe(-4)
    expect(db.user.update.mock.calls).toEqual([
      [
        {
          where: { id: 7 },
          data: { moemoepoint: { increment: -24 } },
          select: { moemoepoint: true }
        }
      ]
    ])
  })
})

describe('收回奖励', () => {
  it('按作者合并、升序扣回, 不另外加锁, 返回被收回的作者', async () => {
    await expect(
      revokeCredits(tx, 'resource_publish', [9, 7, 7])
    ).resolves.toEqual([7, 9])
    expect(db.user.update.mock.calls).toEqual([
      [{ where: { id: 7 }, data: { moemoepoint: { increment: -6 } } }],
      [{ where: { id: 9 }, data: { moemoepoint: { increment: -3 } } }]
    ])
    expect(db.$executeRaw).not.toHaveBeenCalled()
  })

  it('没有作者时不写', async () => {
    await expect(revokeCredits(tx, 'resource_publish', [])).resolves.toEqual([])
    expect(db.user.update).not.toHaveBeenCalled()
  })
})
