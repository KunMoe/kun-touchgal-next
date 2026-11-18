import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)
const { patchContentMock } = vi.hoisted(() => ({ patchContentMock: vi.fn() }))

vi.mock('~/prisma/index', () => rec.module)
// submit.ts 读审核配置要连 Redis; 这里只用到它的 deletePendingModerationTasks
vi.mock('~/server/moderation/config', () => ({ getModerationConfig: vi.fn() }))
vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: vi.fn()
}))
vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCacheByPatchId: patchContentMock
}))
vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: vi.fn()
}))
vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: vi.fn()
}))
vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: vi.fn()
}))
vi.mock('~/server/content/comment/publish', () => ({
  onCommentPublished: vi.fn()
}))

import { deletePatchRating } from '~/app/api/patch/rating/delete'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'

const locked = (status: number) => ({
  id: 5,
  user_id: 7,
  patch_id: 10,
  status
})
const snapshot = (status = 0) => ({ id: 5, user_id: 7, status })

// snapshot 是事务外预检读到的行; lockedRows 是行锁下重读到的
const seed = (
  row: ReturnType<typeof snapshot> | null,
  lockedRows: ReturnType<typeof locked>[]
) => {
  rec.on('patch_rating.findUnique', row)
  rec.onRaw(
    /FROM patch_rating WHERE id = ANY\(\?::int\[\]\) ORDER BY id FOR UPDATE$/,
    lockedRows
  )
}

const shortLabels = () =>
  rec
    .labels()
    .map((label) =>
      label.includes('FOR KEY SHARE')
        ? 'lock patch'
        : label.includes('FOR UPDATE')
          ? 'lock rating'
          : label.includes('pg_advisory_xact_lock')
            ? 'stat.lock'
            : label.includes('INSERT INTO patch_rating_stat')
              ? 'stat.upsert'
              : label
    )

const expectNothingRemoved = () => {
  expect(rec.labels()).not.toContain('patch_rating.deleteMany')
  expect(rec.labels()).not.toContain('moderation_task.deleteMany')
  expect(shortLabels()).not.toContain('stat.upsert')
  expect(patchContentMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('deletePatchRating 事务外预检', () => {
  it.each([
    ['评价不存在', null, 7, 1, '评价不存在'],
    // 隐藏的评价仅后台可管理, 前端与不存在等同 (对管理员也一样)
    ['评价已隐藏', snapshot(2), 9, 3, '评价不存在'],
    ['不是作者也不是管理员', snapshot(0), 8, 1, '您没有权限删除该评价'],
    [
      '作者删自己待审的评价',
      snapshot(1),
      7,
      1,
      '该评价正在审核中, 暂时无法删除'
    ]
  ] as const)('%s', async (_name, row, uid, role, message) => {
    seed(row, [])

    expect(
      await deletePatchRating({ ratingId: 5 }, kunTestActor({ uid, role }))
    ).toBe(message)
    expect(rec.attempts).toHaveLength(0)
  })
})

describe('deletePatchRating 删除', () => {
  it('删除、清理与统计重算在同一事务里, 提交后才失效补丁详情缓存', async () => {
    seed(snapshot(), [locked(0)])
    const cacheSeesCommit: boolean[] = []
    patchContentMock.mockImplementation(async () => {
      cacheSeesCommit.push(rec.attempts[0].committed)
    })

    const result = await deletePatchRating(
      { ratingId: 5 },
      kunTestActor({ uid: 7, role: 1 })
    )

    expect(result).toEqual({})
    // 举报外键 SET NULL: 删除后按 NULL 目标清理级联置空的孤儿 (锁序一致);
    // content_id 无外键, 该评价未决的审核任务与申诉须在删除方显式清理
    expect(shortLabels()).toEqual([
      'lock patch',
      'lock rating',
      'patch_rating.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_report.deleteMany',
      'stat.lock',
      'stat.upsert'
    ])
    expect(rec.argsOf('patch_rating.deleteMany')).toEqual([
      { where: { id: { in: [5] } } }
    ])
    // ratingSummary 随评分统计变化 (M-05)
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
    expect(cacheSeesCommit).toEqual([true])
  })

  it('管理员可以删除他人待审的评价: 待审评价不计入统计, 不重算也不失效缓存', async () => {
    seed(snapshot(1), [locked(1)])

    expect(
      await deletePatchRating(
        { ratingId: 5 },
        kunTestActor({ uid: 9, role: 3 })
      )
    ).toEqual({})
    expect(rec.labels()).toContain('patch_rating.deleteMany')
    expect(shortLabels()).not.toContain('stat.upsert')
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('统计重算失败时删除一并回滚', async () => {
    seed(snapshot(), [locked(0)])
    rec.onRaw(/^INSERT INTO patch_rating_stat/, () => {
      throw new Error('rating stat failed')
    })

    await expect(
      deletePatchRating({ ratingId: 5 }, kunTestActor({ uid: 7, role: 1 }))
    ).rejects.toThrow('rating stat failed')
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(patchContentMock).not.toHaveBeenCalled()
  })
})

// 预检读的是快照, 与事务之间隔着一个窗口: 其间评价被管理员隐藏、被编辑送审,
// 或被别人删掉。同一组条件在行锁下再判一次, 不通过就什么都不动
describe('deletePatchRating 行锁下复检', () => {
  it('快照公开, 锁下已被隐藏: 与不存在等同', async () => {
    seed(snapshot(), [locked(2)])

    expect(
      await deletePatchRating(
        { ratingId: 5 },
        kunTestActor({ uid: 7, role: 1 })
      )
    ).toBe('评价不存在')
    expect(rec.attempts[0].rolledBack).toBe(true)
    expectNothingRemoved()
  })

  it('隐藏复检对管理员同样生效', async () => {
    seed(snapshot(), [locked(2)])

    expect(
      await deletePatchRating(
        { ratingId: 5 },
        kunTestActor({ uid: 9, role: 3 })
      )
    ).toBe('评价不存在')
    expectNothingRemoved()
  })

  it('快照公开, 锁下已转待审: 作者被拒', async () => {
    seed(snapshot(), [locked(1)])

    expect(
      await deletePatchRating(
        { ratingId: 5 },
        kunTestActor({ uid: 7, role: 1 })
      )
    ).toBe('该评价正在审核中, 暂时无法删除')
    expectNothingRemoved()
  })

  it('锁下行已不存在', async () => {
    seed(snapshot(), [])

    expect(
      await deletePatchRating(
        { ratingId: 5 },
        kunTestActor({ uid: 7, role: 1 })
      )
    ).toBe('评价不存在')
    expectNothingRemoved()
  })
})
