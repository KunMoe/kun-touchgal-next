import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)
const { patchContentMock } = vi.hoisted(() => ({ patchContentMock: vi.fn() }))

vi.mock('~/prisma/index', () => rec.module)
// submit.ts 读审核配置要连 Redis; 这里只用到它的入队
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
import { editRating } from '~/server/content/rating/edit'
import { ratingSubject } from '~/server/moderation/subject'
import { MODERATION_SKIP } from '~/server/moderation/submit'

const LOCK =
  '$queryRaw: SELECT id, user_id, patch_id, status, overall, recommend FROM patch_rating WHERE id = ? FOR UPDATE'

const row = (status: number, overrides: Record<string, unknown> = {}) => ({
  id: 5,
  user_id: 7,
  patch_id: 10,
  status,
  overall: 8,
  recommend: 'yes',
  ...overrides
})

// 与库中相同的评分与推荐度, 只改了短评
const textOnly = { overall: 8, recommend: 'yes', short_summary: 'after' }
const INTERCEPT = {
  queue: true,
  intercept: true,
  dryRun: false,
  subject: ratingSubject('after')
} as const

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

const edit = (options: Parameters<typeof editRating>[2]) =>
  kunTx('probe', async (ctx) => {
    const { row: edited, skipped } = await editRating(ctx, 5, options)
    return { edited, skipped }
  }) as Promise<{ edited: unknown; skipped: unknown }>

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('评价编辑', () => {
  it('只改短评: 锁行后写入, 评分没变所以不重算统计、不失效缓存', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(0)])

    const { edited } = await edit({
      data: textOnly,
      moderation: MODERATION_SKIP
    })

    expect(edited).toMatchObject({ id: 5 })
    expect(shortLabels()).toEqual([LOCK, 'patch_rating.updateMany'])
    expect(rec.argsOf('patch_rating.updateMany')).toEqual([
      { where: { id: 5 }, data: { ...textOnly, status: 0 } }
    ])
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it.each([
    ['评分', { ...textOnly, overall: 3 }],
    ['推荐度', { ...textOnly, recommend: 'no' }]
  ])('公开评价改了%s: 提交前重算统计, 提交后失效详情缓存', async (_n, data) => {
    rec.onRaw(/FOR UPDATE$/, [row(0)])
    const cacheSeesCommit: boolean[] = []
    patchContentMock.mockImplementation(async () => {
      cacheSeesCommit.push(rec.attempts[0].committed)
    })

    await edit({ data, moderation: MODERATION_SKIP })

    expect(shortLabels()).toEqual([
      LOCK,
      'patch_rating.updateMany',
      'stat.lock',
      'stat.upsert'
    ])
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
    expect(cacheSeesCommit).toEqual([true])
  })

  // 管理员代改他人评价: 任务仍归评价作者, 并带上补丁 id
  it('预筛拦截: 评价转待审核并退出统计, 同一事务内按作者建任务', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(0)])

    await edit({ data: textOnly, moderation: INTERCEPT })

    expect(shortLabels()).toEqual([
      LOCK,
      'patch_rating.updateMany',
      'moderation_task.updateMany',
      'moderation_task.create',
      'stat.lock',
      'stat.upsert'
    ])
    expect(rec.argsOf('patch_rating.updateMany')).toEqual([
      { where: { id: 5 }, data: { ...textOnly, status: 1 } }
    ])
    expect(rec.argsOf('moderation_task.create')).toEqual([
      {
        data: expect.objectContaining({
          content_type: 'rating',
          content_id: 5,
          patch_id: 10,
          user_id: 7
        })
      }
    ])
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
  })

  // 待审与隐藏的评价不计入统计, 怎么改都不必重算
  it('编辑待审评价的评分不重算统计', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(1)])

    await edit({
      data: { ...textOnly, overall: 1 },
      moderation: MODERATION_SKIP
    })

    expect(shortLabels()).toEqual([LOCK, 'patch_rating.updateMany'])
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('统计重算失败时编辑一并回滚', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(0)])
    rec.onRaw(/^INSERT INTO patch_rating_stat/, () => {
      throw new Error('rating stat failed')
    })

    await expect(
      edit({ data: { ...textOnly, overall: 3 }, moderation: MODERATION_SKIP })
    ).rejects.toThrow('rating stat failed')
    expect(rec.attempts[0].rolledBack).toBe(true)
  })
})

describe('评价编辑的守卫在行锁下判定', () => {
  it('锁下已被隐藏: 不写入、不建任务、不重算', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(2)])

    const { edited, skipped } = await edit({
      guard: { statusIn: [0], ownerUid: 7 },
      data: { ...textOnly, overall: 3 },
      moderation: INTERCEPT
    })

    expect(edited).toBeUndefined()
    expect(skipped).toEqual({ id: 5, reason: 'status', status: 2 })
    expect(rec.labels()).toEqual([LOCK])
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('不是作者', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(0)])

    const { skipped } = await edit({
      guard: { statusIn: [0], ownerUid: 8 },
      data: textOnly,
      moderation: MODERATION_SKIP
    })

    expect(skipped).toEqual({ id: 5, reason: 'owner' })
  })

  it('行已不存在', async () => {
    rec.onRaw(/FOR UPDATE$/, [])

    const { skipped } = await edit({
      data: textOnly,
      moderation: MODERATION_SKIP
    })

    expect(skipped).toEqual({ id: 5, reason: 'gone' })
  })

  // 后台编辑不设守卫: 隐藏的评价也能改短评, 改完仍是隐藏
  it('不传守卫时隐藏的评价也能改, 状态不变', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(2)])

    await edit({
      data: { short_summary: 'after' },
      moderation: MODERATION_SKIP
    })

    expect(rec.argsOf('patch_rating.updateMany')).toEqual([
      { where: { id: 5 }, data: { short_summary: 'after', status: 2 } }
    ])
    expect(shortLabels()).not.toContain('stat.upsert')
  })
})
