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

import { deleteRating } from '~/app/api/admin/rating/delete'

const created = new Date('2026-01-01T00:00:00.000Z')
const rating = (id: number, patchId: number, status: number) => ({
  id,
  recommend: 'yes',
  overall: 8,
  play_status: 'finished_main',
  short_summary: `rating-${id}`,
  spoiler_level: 'none',
  status,
  user_id: id + 100,
  patch_id: patchId,
  created,
  updated: created
})
const locked = (id: number, patchId: number, status: number) => ({
  id,
  user_id: id + 100,
  patch_id: patchId,
  status
})

const RATING_LOCK =
  /FROM patch_rating WHERE id = ANY\(\?::int\[\]\) ORDER BY id FOR UPDATE$/

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

const logContent = () =>
  (rec.argsOf('admin_log.create')[0] as { data: { content: string } }).data
    .content

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  rec.on('user.findUnique', { id: 99, name: 'admin' })
  // 事务外快照: 1 隐藏、2 与 3 公开、4 隐藏
  rec.on('patch_rating.findMany', [
    rating(1, 10, 2),
    rating(2, 10, 0),
    rating(3, 20, 0),
    rating(4, 30, 2)
  ])
})

describe('deleteRating', () => {
  // 快照与事务之间状态变了: 1 被恢复公开, 3 被隐藏。重算以锁下的当前状态为准
  it('先锁 patch 再锁评价行, 只重算锁下公开评价所在的补丁', async () => {
    rec.onRaw(RATING_LOCK, [
      locked(1, 10, 0),
      locked(2, 10, 0),
      locked(3, 20, 2),
      locked(4, 30, 2)
    ])

    await expect(
      deleteRating({ ratingIds: [1, 2, 3, 4] }, 99)
    ).resolves.toEqual({})

    expect(rec.attempts[0].committed).toBe(true)
    // 举报外键 SET NULL: 删除后按 NULL 目标清理级联置空的孤儿 (锁序一致)
    expect(shortLabels()).toEqual([
      'lock patch',
      'lock rating',
      'patch_rating.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_report.deleteMany',
      'stat.lock',
      'stat.upsert',
      'admin_log.create'
    ])
    const statLock = rec
      .labels()
      .find((label) => label.includes('pg_advisory_xact_lock')) as string
    expect(rec.argsOf(statLock)).toEqual([[481002, 10]])
    // 公开评价被删 → ratingSummary 变; 隐藏评价所在的补丁 20 / 30 不失效
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
    expect(logContent()).toContain('批量删除了 4 条评价')
  })

  it('审计日志只记锁下实际删掉的评价', async () => {
    rec.onRaw(RATING_LOCK, [locked(2, 10, 0)])

    await deleteRating({ ratingIds: [1, 2, 3, 4] }, 99)

    expect(rec.argsOf('patch_rating.deleteMany')).toEqual([
      { where: { id: { in: [2] } } }
    ])
    expect(logContent()).toContain('删除了一条评价')
    expect(logContent()).toContain('"id":2')
  })

  it('锁下一条都不剩时报未找到, 不写审计', async () => {
    rec.onRaw(RATING_LOCK, [])

    expect(await deleteRating({ ratingIds: [1, 2, 3, 4] }, 99)).toBe(
      '未找到对应的评价'
    )
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(rec.labels()).not.toContain('admin_log.create')
  })

  it('原生语句报出的 PostgreSQL 死锁会重放整个事务', async () => {
    const conflictError = Object.assign(new Error('raw query failed'), {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: { kind: 'postgres', originalCode: '40P01' }
        }
      }
    })
    let lockCalls = 0
    rec.onRaw(RATING_LOCK, () => {
      lockCalls++
      if (lockCalls === 1) {
        throw conflictError
      }
      return [locked(2, 10, 0)]
    })

    await expect(
      deleteRating({ ratingIds: [1, 2, 3, 4] }, 99)
    ).resolves.toEqual({})

    // 快照只读一次, 事务重放一次; 被回滚的那次不留下任何副作用
    expect(
      rec.outside.filter((item) => item.label === 'patch_rating.findMany')
    ).toHaveLength(1)
    expect(rec.attempts.map((attempt) => attempt.committed)).toEqual([
      false,
      true
    ])
    expect(patchContentMock).toHaveBeenCalledTimes(1)
  })

  it('事务外一条都没读到时不开事务', async () => {
    rec.on('patch_rating.findMany', [])

    expect(await deleteRating({ ratingIds: [1] }, 99)).toBe('未找到对应的评价')
    expect(rec.attempts).toHaveLength(0)
  })
})
