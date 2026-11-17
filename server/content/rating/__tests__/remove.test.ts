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

import { kunTx } from '~/server/db/tx'
import {
  executeRatingRemoval,
  planRatingRemoval
} from '~/server/content/rating/remove'
import type {
  RatingRemovalGuard,
  RatingRemovalPlan
} from '~/server/content/rating/remove'

const PATCH_LOCK =
  '$executeRaw: SELECT id FROM patch WHERE id IN ( SELECT patch_id FROM patch_rating WHERE id = ANY(?::int[]) ) ORDER BY id FOR KEY SHARE'
const RATING_LOCK =
  '$queryRaw: SELECT id, user_id, patch_id, status FROM patch_rating WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE'
const STAT_LOCK_PREFIX = '$executeRaw: SELECT pg_advisory_xact_lock('
const STAT_UPSERT_PREFIX = '$executeRaw: INSERT INTO patch_rating_stat'

const row = (id: number, patchId: number, status = 0) => ({
  id,
  user_id: 7,
  patch_id: patchId,
  status
})

const seed = (locked: ReturnType<typeof row>[]) => {
  rec.onRaw(
    /FROM patch_rating WHERE id = ANY\(\?::int\[\]\) ORDER BY id FOR UPDATE$/,
    locked
  )
}

// 统计重算的两条原生语句只看前缀
const shortLabels = () =>
  rec
    .labels()
    .map((label) =>
      label.startsWith(STAT_LOCK_PREFIX)
        ? 'stat.lock'
        : label.startsWith(STAT_UPSERT_PREFIX)
          ? 'stat.upsert'
          : label
    )

const remove = (
  ids: number[],
  guard?: RatingRemovalGuard,
  orphanReports: 'inline' | 'caller' = 'inline'
) =>
  kunTx('probe', async (ctx) => {
    const plan = await planRatingRemoval(ctx, ids, guard)
    const result = await executeRatingRemoval(ctx, plan, { orphanReports })
    return { plan, ...result }
  }) as Promise<{ plan: RatingRemovalPlan; deletedIds: number[] }>

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('评价删除的语句顺序', () => {
  it('锁 patch → 锁评价行 → 删除 → 清任务与申诉 → 清孤儿举报 → 重算统计', async () => {
    seed([row(5, 10)])

    const { deletedIds } = await remove([5])

    expect(deletedIds).toEqual([5])
    expect(rec.attempts[0].committed).toBe(true)
    expect(shortLabels()).toEqual([
      PATCH_LOCK,
      RATING_LOCK,
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
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      {
        where: {
          content_type: 'rating',
          content_id: { in: [5] },
          status: { in: ['pending', 'manual'] }
        }
      }
    ])
    // 孤儿举报: 目标已被级联置空且仍未处理
    expect(rec.argsOf('patch_report.deleteMany')).toEqual([
      { where: { target_type: 'rating', status: 0, rating_id: null } }
    ])
  })

  it('批量删除: 两类锁都按 id 升序, 一条语句锁整批', async () => {
    seed([row(1, 30), row(2, 10), row(3, 20)])

    await remove([3, 1, 2])

    expect(rec.argsOf(PATCH_LOCK)).toEqual([[[3, 1, 2]]])
    expect(rec.argsOf(RATING_LOCK)).toEqual([[[3, 1, 2]]])
    expect(rec.argsOf('patch_rating.deleteMany')).toEqual([
      { where: { id: { in: [1, 2, 3] } } }
    ])
  })

  // 统计只算公开评价 (status = 0)
  it('只对删除时公开的评价所在的补丁重算统计', async () => {
    seed([row(1, 10, 2), row(2, 10, 0), row(3, 20, 2), row(4, 30, 1)])

    await remove([1, 2, 3, 4])

    const statLock = rec
      .labels()
      .find((label) => label.startsWith(STAT_LOCK_PREFIX)) as string
    // 通告锁与重算的参数里只有补丁 10
    expect(rec.argsOf(statLock)).toEqual([[481002, 10]])
  })

  it('删掉的全是隐藏或待审评价时不重算统计', async () => {
    seed([row(1, 10, 2), row(2, 20, 1)])

    await remove([1, 2])

    expect(shortLabels()).not.toContain('stat.lock')
    expect(shortLabels()).not.toContain('stat.upsert')
  })

  // 举报处理要先把本次收集到的举报转为历史, 再由它自己清剩下的孤儿
  it("orphanReports 为 'caller' 时不清孤儿举报", async () => {
    seed([row(5, 10)])

    await remove([5], undefined, 'caller')

    expect(rec.labels()).not.toContain('patch_report.deleteMany')
  })
})

describe('守卫在行锁下判定', () => {
  // 申诉驳回只删隐藏态: 不改统计, 所以不锁 patch
  it('守卫不含公开态时不锁 patch', async () => {
    seed([row(5, 10, 2)])

    const { deletedIds } = await remove([5], { statusIn: [2] })

    expect(deletedIds).toEqual([5])
    expect(shortLabels()).toEqual([
      RATING_LOCK,
      'patch_rating.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_report.deleteMany'
    ])
  })

  it.each([
    ['已恢复公开', 0],
    ['待审', 1]
  ])(
    '状态不在 statusIn 里 (%s) 时跳过: 不删除、不清理、不重算',
    async (_label, status) => {
      seed([row(5, 10, status)])

      const { plan, deletedIds } = await remove([5], { statusIn: [2] })

      expect(plan.rows).toEqual([])
      expect(plan.skipped).toEqual([{ id: 5, reason: 'status', status }])
      expect(deletedIds).toEqual([])
      // 内容保留时, 它的审核任务、申诉、举报都要留着
      expect(rec.labels()).toEqual([RATING_LOCK])
      expect(patchContentMock).not.toHaveBeenCalled()
    }
  )

  it('行已不存在时报 gone', async () => {
    seed([])

    const { plan } = await remove([5], { statusIn: [0] })

    expect(plan.skipped).toEqual([{ id: 5, reason: 'gone' }])
    expect(rec.labels()).toEqual([PATCH_LOCK, RATING_LOCK])
  })

  it('ownerUid 不是作者时报 owner', async () => {
    seed([row(5, 10)])

    const { plan } = await remove([5], { statusIn: [0], ownerUid: 8 })

    expect(plan.skipped).toEqual([{ id: 5, reason: 'owner' }])
    expect(rec.labels()).toEqual([PATCH_LOCK, RATING_LOCK])
  })

  // 后台删除不设守卫: 隐藏、待审的评价都能删
  it('不传守卫时任何状态都删, 并锁 patch', async () => {
    seed([row(1, 10, 2), row(2, 10, 1), row(3, 10, 0)])

    const { plan, deletedIds } = await remove([1, 2, 3])

    expect(plan.skipped).toEqual([])
    expect(deletedIds).toEqual([1, 2, 3])
    expect(rec.labels()[0]).toBe(PATCH_LOCK)
  })
})

describe('提交后的缓存失效由被删行的状态推导', () => {
  it('删除公开评价: 失效补丁详情缓存 (ratingSummary 变)', async () => {
    seed([row(5, 10), row(6, 20)])

    await remove([5, 6])

    expect(patchContentMock.mock.calls).toEqual([[[10, 20]]])
  })

  it('删除隐藏评价不失效缓存', async () => {
    seed([row(5, 10, 2)])

    await remove([5], { statusIn: [2] })

    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('统计重算失败时整个事务回滚, 不失效缓存', async () => {
    seed([row(5, 10)])
    rec.onRaw(/^INSERT INTO patch_rating_stat/, () => {
      throw new Error('rating stat failed')
    })

    await expect(remove([5])).rejects.toThrow('rating stat failed')
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(patchContentMock).not.toHaveBeenCalled()
  })
})
