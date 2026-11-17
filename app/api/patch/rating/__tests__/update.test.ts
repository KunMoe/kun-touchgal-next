import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findUniqueMock,
  findUpdatedMock,
  transactionMock,
  editRatingMock,
  planTextModerationMock,
  hasPendingModerationMock
} = vi.hoisted(() => ({
  findUniqueMock: vi.fn(),
  findUpdatedMock: vi.fn(),
  transactionMock: vi.fn(),
  editRatingMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  hasPendingModerationMock: vi.fn()
}))

const transactionClient = {
  patch_rating: { findUniqueOrThrow: findUpdatedMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_rating: { findUnique: findUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/server/moderation/submit', () => ({
  hasPendingModeration: hasPendingModerationMock,
  planTextModeration: planTextModerationMock
}))

// 锁行、行锁下复检守卫、写入、建任务、统计重算与缓存失效由编辑命令自己的测试覆盖;
// 这里只看入口的预检、给命令的守卫与送审计划, 以及文案映射
vi.mock('~/server/content/rating/edit', () => ({
  editRating: editRatingMock
}))

import { ratingSubject } from '~/server/moderation/subject'
import { updatePatchRating } from '~/app/api/patch/rating/update'

const input = {
  ratingId: 5,
  recommend: 'yes',
  overall: 8,
  playStatus: 'finished_main',
  shortSummary: 'summary',
  spoilerLevel: 'none'
}
const created = new Date('2026-01-01T00:00:00.000Z')
const stored = { id: 5, user_id: 7, status: 0, short_summary: 'before' }
const updated = {
  id: 5,
  patch_id: 10,
  user_id: 7,
  recommend: 'yes',
  overall: 8,
  play_status: 'finished_main',
  short_summary: 'summary',
  spoiler_level: 'none',
  status: 0,
  created,
  updated: created,
  patch: { unique_id: 'patch-10' },
  user: { id: 7, name: 'user', avatar: 'avatar' },
  _count: { like: 3 },
  like: [{ user_id: 7 }]
}
const SKIP = { queue: false, intercept: false, dryRun: false }

const txContext = expect.objectContaining({ tx: transactionClient })

beforeEach(() => {
  vi.resetAllMocks()
  findUniqueMock.mockResolvedValue(stored)
  findUpdatedMock.mockResolvedValue(updated)
  hasPendingModerationMock.mockResolvedValue(false)
  planTextModerationMock.mockResolvedValue(SKIP)
  editRatingMock.mockResolvedValue({ row: { id: 5 }, skipped: undefined })
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => unknown) =>
      callback(transactionClient)
  )
})

describe('updatePatchRating', () => {
  it('编辑评价时把编辑前的短评作为 previous 交给预筛, 由预筛判定是否重审', async () => {
    await updatePatchRating(input, 7, 1)

    expect(planTextModerationMock).toHaveBeenCalledWith(
      ratingSubject('summary'),
      { userRole: 1, previous: ratingSubject('before') }
    )
  })

  it('把各字段与预筛结果交给编辑命令, 在同一事务里读回写入后的行作为响应', async () => {
    const result = await updatePatchRating(input, 7, 1)

    expect(editRatingMock).toHaveBeenCalledWith(txContext, 5, {
      guard: { statusIn: [0], ownerUid: 7 },
      data: {
        recommend: 'yes',
        overall: 8,
        play_status: 'finished_main',
        short_summary: 'summary',
        spoiler_level: 'none'
      },
      moderation: SKIP
    })
    expect(editRatingMock.mock.invocationCallOrder[0]).toBeLessThan(
      findUpdatedMock.mock.invocationCallOrder[0]
    )
    expect(result).toEqual({
      id: 5,
      uniqueId: 'patch-10',
      recommend: 'yes',
      overall: 8,
      playStatus: 'finished_main',
      shortSummary: 'summary',
      spoilerLevel: 'none',
      status: 0,
      isLike: true,
      likeCount: 3,
      userId: 7,
      patchId: 10,
      created,
      updated: created,
      user: { id: 7, name: 'user', avatar: 'avatar' }
    })
  })

  it('编辑命令抛错 (如统计重算失败) 时原样抛出', async () => {
    editRatingMock.mockRejectedValue(new Error('rating stat failed'))

    await expect(updatePatchRating(input, 7, 1)).rejects.toThrow(
      'rating stat failed'
    )
  })
})

describe('updatePatchRating 事务外预检', () => {
  it.each([
    ['评价不存在', null, 7, 1, '评价不存在'],
    // 隐藏的评价仅后台可管理, 前端与不存在等同 (对管理员也一样)
    ['评价已隐藏', { ...stored, status: 2 }, 9, 3, '评价不存在'],
    ['不是作者也不是管理员', stored, 8, 1, '您没有权限更新该评价'],
    [
      '作者改自己待审的评价',
      { ...stored, status: 1 },
      7,
      1,
      '您发布的评价正在审核中, 暂时无法修改'
    ]
  ])('%s', async (_name, row, uid, role, message) => {
    findUniqueMock.mockResolvedValue(row)

    expect(await updatePatchRating(input, uid, role)).toBe(message)
    expect(planTextModerationMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('审核中的评价禁止作者再次修改, 不进入预筛', async () => {
    hasPendingModerationMock.mockResolvedValue(true)

    expect(await updatePatchRating(input, 7, 1)).toBe(
      '您发布的评价正在审核中, 暂时无法修改'
    )
    expect(transactionMock).not.toHaveBeenCalled()
  })
})

// 预检读的是快照; 同一组条件作为守卫交给编辑命令在行锁下再判一次
describe('updatePatchRating 给编辑命令的守卫', () => {
  it('管理员: 可以改他人公开或待审的评价, 隐藏的不行', async () => {
    await updatePatchRating(input, 9, 3)

    expect(editRatingMock.mock.calls[0][2].guard).toEqual({ statusIn: [0, 1] })
  })

  it.each([
    // 快照之后被管理员隐藏: 这次编辑不会把它写回待审核
    [{ id: 5, reason: 'status', status: 2 }, '评价不存在'],
    [
      { id: 5, reason: 'status', status: 1 },
      '您发布的评价正在审核中, 暂时无法修改'
    ],
    [{ id: 5, reason: 'gone' }, '评价不存在'],
    [{ id: 5, reason: 'owner' }, '您没有权限更新该评价']
  ])('行锁下守卫未通过 %o → %s', async (skipped, message) => {
    editRatingMock.mockResolvedValue({ row: undefined, skipped })

    expect(await updatePatchRating(input, 7, 1)).toBe(message)
    expect(findUpdatedMock).not.toHaveBeenCalled()
  })
})
