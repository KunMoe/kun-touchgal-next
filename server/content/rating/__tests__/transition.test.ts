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
import { transitionRatings } from '~/server/content/rating/transition'

const LOCK =
  '$queryRaw: SELECT id, patch_id, status FROM patch_rating WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE'

const row = (id: number, patchId: number, status: number) => ({
  id,
  patch_id: patchId,
  status
})

const shortLabels = () =>
  rec
    .labels()
    .map((label) =>
      label.includes('pg_advisory_xact_lock')
        ? 'stat.lock'
        : label.includes('INSERT INTO patch_rating_stat')
          ? 'stat.upsert'
          : label
    )

const transition = (
  ids: number[],
  options: Parameters<typeof transitionRatings>[2]
) => kunTx('probe', (ctx) => transitionRatings(ctx, ids, options))

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('评价状态迁移', () => {
  it('锁行 → 写 status → 作废在途任务 (保留 dry_run) → 重算统计', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 10, 0)])

    const moved = await transition([5], {
      from: [0, 1],
      to: 2,
      openTasks: 'cancel-keep-dry-run'
    })

    expect(moved).toEqual([{ id: 5, from: 0 }])
    expect(shortLabels()).toEqual([
      LOCK,
      'patch_rating.updateMany',
      'moderation_task.deleteMany',
      'stat.lock',
      'stat.upsert'
    ])
    expect(rec.argsOf('patch_rating.updateMany')).toEqual([
      {
        where: { id: { in: [5] }, status: { in: [0, 1] } },
        data: { status: 2 }
      }
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      {
        where: {
          content_type: 'rating',
          content_id: { in: [5] },
          status: { in: ['pending', 'manual'] },
          dry_run: false
        }
      }
    ])
  })

  it('只迁移锁下状态在 from 里的行', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(1, 10, 1), row(2, 20, 0)])

    const moved = await transition([1, 2, 3], {
      from: [1],
      to: 0,
      openTasks: 'keep'
    })

    expect(moved).toEqual([{ id: 1, from: 1 }])
    expect(rec.argsOf('patch_rating.updateMany')).toEqual([
      { where: { id: { in: [1] }, status: { in: [1] } }, data: { status: 0 } }
    ])
    expect(rec.labels()).not.toContain('moderation_task.deleteMany')
  })

  it('没有行可迁移时只有取锁语句', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 10, 0)])

    expect(
      await transition([5], { from: [2], to: 0, openTasks: 'keep' })
    ).toEqual([])
    expect(rec.labels()).toEqual([LOCK])
  })

  it('data 里的字段随状态一起写', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 10, 2)])

    await transition([5], {
      from: [2],
      to: 0,
      data: { short_summary: 'restored' },
      openTasks: 'keep'
    })

    expect(rec.argsOf('patch_rating.updateMany')).toEqual([
      {
        where: { id: { in: [5] }, status: { in: [2] } },
        data: { short_summary: 'restored', status: 0 }
      }
    ])
  })
})

// 统计与 ratingSummary 只算公开评价
describe('评价状态迁移的统计重算与缓存失效', () => {
  it.each([
    ['待审通过', 1, 0, true],
    ['隐藏恢复', 2, 0, true],
    ['公开评价被隐藏', 0, 2, true],
    ['待审被拒', 1, 2, false]
  ] as const)('%s', async (_name, from, to, touched) => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 10, from)])

    await transition([5], { from: [from], to, openTasks: 'keep' })

    expect(shortLabels().includes('stat.upsert')).toBe(touched)
    expect(patchContentMock.mock.calls).toEqual(touched ? [[[10]]] : [])
  })

  it('统计重算失败时迁移一并回滚', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 10, 1)])
    rec.onRaw(/^INSERT INTO patch_rating_stat/, () => {
      throw new Error('rating stat failed')
    })

    await expect(
      transition([5], { from: [1], to: 0, openTasks: 'keep' })
    ).rejects.toThrow('rating stat failed')
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(patchContentMock).not.toHaveBeenCalled()
  })
})
