import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findRatingMock,
  findAdminMock,
  transactionMock,
  createLogMock,
  planTextModerationMock,
  editRatingMock
} = vi.hoisted(() => ({
  findRatingMock: vi.fn(),
  findAdminMock: vi.fn(),
  transactionMock: vi.fn(),
  createLogMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  editRatingMock: vi.fn()
}))

const transactionClient = {
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_rating: { findUnique: findRatingMock },
    user: { findUnique: findAdminMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/server/moderation/submit', () => ({
  planTextModeration: planTextModerationMock
}))

// 锁行、写入、统计重算与缓存失效由编辑命令自己的测试覆盖; 这里只看后台入口怎么用它
vi.mock('~/server/content/rating/edit', () => ({
  editRating: editRatingMock
}))

import { ratingSubject } from '~/server/moderation/subject'
import { updateRating } from '~/app/api/admin/rating/update'

const created = new Date('2026-01-01T00:00:00.000Z')
const SKIP = { queue: false, intercept: false, dryRun: false }

beforeEach(() => {
  vi.resetAllMocks()
  findRatingMock.mockResolvedValue({
    id: 1,
    recommend: 'yes',
    overall: 8,
    play_status: 'finished_main',
    short_summary: 'old',
    spoiler_level: 'none',
    status: 0,
    user_id: 101,
    patch_id: 10,
    created,
    updated: created
  })
  findAdminMock.mockResolvedValue({ id: 99, name: 'admin' })
  planTextModerationMock.mockResolvedValue(SKIP)
  editRatingMock.mockResolvedValue({ row: { id: 1 }, skipped: undefined })
  createLogMock.mockResolvedValue({})
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('updateRating', () => {
  it('updates only short_summary, without a guard, and logs the old rating', async () => {
    await expect(
      updateRating({ ratingId: 1, shortSummary: 'new' }, 99, 4)
    ).resolves.toEqual({})

    // 参数整体精确匹配: 只写短评; 后台编辑不设守卫 (隐藏、待审的评价都能改)
    expect(editRatingMock).toHaveBeenCalledTimes(1)
    expect(editRatingMock).toHaveBeenCalledWith(
      expect.objectContaining({ tx: transactionClient }),
      1,
      { data: { short_summary: 'new' }, moderation: SKIP }
    )

    expect(createLogMock).toHaveBeenCalledTimes(1)
    expect(createLogMock.mock.calls[0][0].data.content).toContain(
      '管理员 admin 更新了一条评价的简评'
    )
    expect(createLogMock.mock.calls[0][0].data.content).toContain(
      '"short_summary":"old"'
    )
  })

  // 送审豁免只看操作者的真实角色 (超级管理员豁免), 后台入口不另开口子
  it('以操作者的真实角色与编辑前的短评交给预筛', async () => {
    await updateRating({ ratingId: 1, shortSummary: 'new' }, 99, 4)

    expect(planTextModerationMock).toHaveBeenCalledWith(ratingSubject('new'), {
      userRole: 4,
      previous: ratingSubject('old')
    })
  })

  it('returns an error message when the rating does not exist', async () => {
    findRatingMock.mockResolvedValue(null)

    await expect(
      updateRating({ ratingId: 1, shortSummary: 'new' }, 99, 4)
    ).resolves.toBe('未找到对应的评价')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('评价在行锁下已不存在时报未找到, 不记日志', async () => {
    editRatingMock.mockResolvedValue({
      row: undefined,
      skipped: { id: 1, reason: 'gone' }
    })

    await expect(
      updateRating({ ratingId: 1, shortSummary: 'new' }, 99, 4)
    ).resolves.toBe('未找到对应的评价')
    expect(createLogMock).not.toHaveBeenCalled()
  })
})
