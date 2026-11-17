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

import { updateRatingShadowBan } from '~/app/api/admin/rating/shadow-ban/shadowBan'

// snapshotStatus 是事务外预检读到的状态; lockedStatus 是行锁下读到的 (null 即已删除)
const seed = (
  snapshotStatus: number,
  lockedStatus: number | null = snapshotStatus
) => {
  rec.on('patch_rating.findUnique', (args: { select: { status?: boolean } }) =>
    // 带 status 的是事务外预检; 不带的是迁移落空后查行是否还在
    args.select.status
      ? { id: 5, status: snapshotStatus, user: { name: 'user' } }
      : lockedStatus === null
        ? null
        : { id: 5 }
  )
  rec.onRaw(
    /FROM patch_rating .* FOR UPDATE$/,
    lockedStatus === null ? [] : [{ id: 5, patch_id: 10, status: lockedStatus }]
  )
}

const shortLabels = () =>
  rec
    .labels()
    .map((label) =>
      label.includes('FOR UPDATE')
        ? 'lock rating'
        : label.includes('pg_advisory_xact_lock')
          ? 'stat.lock'
          : label.includes('INSERT INTO patch_rating_stat')
            ? 'stat.upsert'
            : label
    )

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  rec.on('user.findUnique', { id: 99, name: 'admin' })
  seed(0)
})

describe('updateRatingShadowBan 拒绝分支', () => {
  it('管理员不存在', async () => {
    rec.on('user.findUnique', null)

    expect(await updateRatingShadowBan({ ratingId: 5, status: 2 }, 99)).toBe(
      '未找到该管理员'
    )
    expect(rec.attempts).toHaveLength(0)
  })

  it('评价不存在', async () => {
    rec.on('patch_rating.findUnique', null)

    expect(await updateRatingShadowBan({ ratingId: 5, status: 2 }, 99)).toBe(
      '未找到该评价'
    )
    expect(rec.attempts).toHaveLength(0)
  })

  it('已处于目标状态', async () => {
    seed(2)

    expect(await updateRatingShadowBan({ ratingId: 5, status: 2 }, 99)).toBe(
      '该评价已处于隐藏状态'
    )
    expect(rec.attempts).toHaveLength(0)
  })

  // 预检读的是快照; 同样的判断在行锁下再做一次
  it('快照正常, 锁下已被别人隐藏: 不写状态、不重算、不记审计', async () => {
    seed(0, 2)

    expect(await updateRatingShadowBan({ ratingId: 5, status: 2 }, 99)).toBe(
      '该评价已处于隐藏状态'
    )
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(shortLabels()).toEqual(['lock rating', 'patch_rating.findUnique'])
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('锁下评价已被删除', async () => {
    seed(0, null)

    expect(await updateRatingShadowBan({ ratingId: 5, status: 2 }, 99)).toBe(
      '未找到该评价'
    )
  })
})

describe('updateRatingShadowBan', () => {
  // 锁序: 评价行 → 审核任务, 与审核裁决、删除一致
  it('先锁评价行, 写 status, 作废在途任务 (保留 dry_run), 提交前重算统计, 提交后失效详情缓存', async () => {
    const cacheSeesCommit: boolean[] = []
    patchContentMock.mockImplementation(async () => {
      cacheSeesCommit.push(rec.attempts[0].committed)
    })

    const result = await updateRatingShadowBan({ ratingId: 5, status: 2 }, 99)

    expect(result).toEqual({})
    expect(shortLabels()).toEqual([
      'lock rating',
      'patch_rating.updateMany',
      'moderation_task.deleteMany',
      'stat.lock',
      'stat.upsert',
      'admin_log.create'
    ])
    // 待审核的评价也可以隐藏
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
    expect(rec.argsOf('admin_log.create')).toEqual([
      {
        data: {
          type: 'update',
          user_id: 99,
          content:
            '管理员 admin 将用户 user 的评价 (ID: 5) 状态由 正常 修改为 隐藏'
        }
      }
    ])
    // ratingSummary 随评分统计变化 (M-05)
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
    expect(cacheSeesCommit).toEqual([true])
  })

  it('恢复为正常: 从隐藏或待审核流转并重算统计', async () => {
    seed(2)

    await updateRatingShadowBan({ ratingId: 5, status: 0 }, 99)

    expect(rec.argsOf('patch_rating.updateMany')).toEqual([
      {
        where: { id: { in: [5] }, status: { in: [1, 2] } },
        data: { status: 0 }
      }
    ])
    expect(shortLabels()).toContain('stat.upsert')
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
  })

  // 待审核与隐藏的评价都不计入统计
  it('隐藏一条待审核的评价: 不重算统计, 审计记行锁下的原状态', async () => {
    seed(0, 1)

    await updateRatingShadowBan({ ratingId: 5, status: 2 }, 99)

    expect(shortLabels()).not.toContain('stat.upsert')
    expect(patchContentMock).not.toHaveBeenCalled()
    expect(
      (rec.argsOf('admin_log.create')[0] as { data: { content: string } }).data
        .content
    ).toContain('状态由 待审核 修改为 隐藏')
  })

  it('统计重算失败时状态迁移一并回滚', async () => {
    rec.onRaw(/^INSERT INTO patch_rating_stat/, () => {
      throw new Error('rating stat failed')
    })

    await expect(
      updateRatingShadowBan({ ratingId: 5, status: 2 }, 99)
    ).rejects.toThrow('rating stat failed')
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(patchContentMock).not.toHaveBeenCalled()
  })
})
