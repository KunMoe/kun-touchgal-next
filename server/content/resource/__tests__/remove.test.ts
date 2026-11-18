import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)
const {
  patchContentMock,
  resourceDetailMock,
  resourceListMock,
  pendingResourceMock,
  userSessionMock,
  kickSearchMock,
  kickS3Mock
} = vi.hoisted(() => ({
  patchContentMock: vi.fn(),
  resourceDetailMock: vi.fn(),
  resourceListMock: vi.fn(),
  pendingResourceMock: vi.fn(),
  userSessionMock: vi.fn(),
  kickSearchMock: vi.fn(),
  kickS3Mock: vi.fn()
}))

vi.mock('~/prisma/index', () => rec.module)
// 积木模块本身照常执行, 只挡掉它们顶层引入的外部服务
vi.mock('~/lib/s3', () => ({}))
vi.mock('~/lib/redis', () => ({}))
vi.mock('~/lib/meilisearch', () => ({ getMeiliClient: () => null }))
vi.mock('~/server/tasks/withTaskLock', () => ({ withTaskLock: vi.fn() }))
vi.mock('~/server/moderation/config', () => ({ getModerationConfig: vi.fn() }))
vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: patchContentMock,
  invalidatePatchContentCacheByPatchId: vi.fn()
}))
vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: vi.fn()
}))
vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: resourceDetailMock
}))
vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: resourceListMock
}))
vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: pendingResourceMock
}))
vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: userSessionMock
}))
vi.mock('~/server/content/comment/publish', () => ({
  onCommentPublished: vi.fn()
}))
vi.mock('~/server/search/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/search/sync')>()),
  kickSearchOutboxDrain: kickSearchMock
}))
vi.mock('~/server/storage/s3Outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/server/storage/s3Outbox')>()),
  kickS3DeletionDrain: kickS3Mock
}))

import { kunTx } from '~/server/db/tx'
import {
  executeResourceRemoval,
  planResourceRemoval
} from '~/server/content/resource/remove'
import type {
  ResourceRemovalGuard,
  ResourceRemovalPlan
} from '~/server/content/resource/remove'
import {
  resourceRow,
  s3EnqueuedKeys,
  seedResourceRemoval
} from './removalFixture'
import type { ResourceRowFixture } from './removalFixture'

const USER_LOCK =
  '$executeRaw: SELECT id FROM "user" WHERE id IN ( SELECT user_id FROM patch_resource WHERE id = ANY(?::int[]) ) ORDER BY id FOR NO KEY UPDATE'
const RESOURCE_LOCK =
  '$queryRaw: SELECT id FROM patch_resource WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE'
const PATCH_LOCK =
  '$executeRaw: SELECT id FROM patch WHERE id = ANY(?::int[]) ORDER BY id FOR NO KEY UPDATE'

const row = resourceRow
const seed = (rows: ResourceRowFixture[], commentedIds: number[] = []) =>
  seedResourceRemoval(rec, rows, commentedIds)

// 通告锁与出箱的原生语句只看前缀
const shortLabels = () =>
  rec
    .labels()
    .map((label) =>
      label.includes('pg_advisory_xact_lock')
        ? 'recalc.lock'
        : label.includes('INSERT INTO search_outbox')
          ? 'search_outbox.enqueue'
          : label.includes('INSERT INTO s3_deletion_outbox')
            ? 's3_deletion_outbox.enqueue'
            : label === PATCH_LOCK
              ? 'patch.lock'
              : label
    )

const remove = (
  ids: number[],
  options: { guard?: ResourceRemovalGuard; refundPublishReward: boolean } = {
    refundPublishReward: false
  }
) =>
  kunTx('probe', async (ctx) => {
    const plan = await planResourceRemoval(ctx, ids, options)
    const result = await executeResourceRemoval(ctx, plan)
    return { plan, ...result }
  }) as Promise<{ plan: ResourceRemovalPlan; deletedIds: number[] }>

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('资源删除的语句顺序', () => {
  it('锁行 → 锁下重读 → 锁 patch 行 → 清评论派生物 → 删除 → 清任务与申诉 → 清孤儿举报 → 重算 → 两个出箱', async () => {
    seed([row(1)], [1])

    const { deletedIds } = await remove([1])

    expect(deletedIds).toEqual([1])
    expect(rec.attempts[0].committed).toBe(true)
    expect(shortLabels()).toEqual([
      RESOURCE_LOCK,
      'patch_resource.findMany',
      // 删除公开资源会让计数触发器去改 patch 行: 先把它锁住
      'patch.lock',
      // cleanupResourceCommentDerivatives: 评论区的站内信、评论的审核任务与申诉
      'patch_resource.findMany',
      'user_message.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_resource.deleteMany',
      // 资源自己的审核任务与申诉
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      // 级联删掉的评论上的孤儿举报
      'patch_report.deleteMany',
      // recalcPatchType: patch 行 → 通告锁 → 读公开资源 → 写补丁聚合
      'patch.lock',
      'recalc.lock',
      'patch_resource.findMany',
      'patch.update',
      'search_outbox.enqueue',
      's3_deletion_outbox.enqueue'
    ])
    expect(rec.argsOf('user_message.deleteMany')).toEqual([
      {
        where: {
          OR: [{ link: { startsWith: '/patch-10/resource/1?commentId=' } }]
        }
      }
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          content_type: 'comment',
          content_id: { in: [100] }
        })
      }),
      expect.objectContaining({
        where: expect.objectContaining({
          content_type: 'resource',
          content_id: { in: [1] }
        })
      })
    ])
    expect(rec.argsOf('patch_report.deleteMany')).toEqual([
      { where: { target_type: 'comment', status: 0, comment_id: null } }
    ])
  })

  // 事务外的快照与删除之间, 并发编辑会整体重建链接行并换 s3 对象
  it('S3 删除按锁下重读的链接入箱, 只收 s3 存储的', async () => {
    seed([row(1), row(2, { patch_id: 20 })])

    await remove([1, 2])

    expect(s3EnqueuedKeys(rec)).toEqual([['k-10', 'k-20']])
  })

  it('批量删除按 id 升序锁资源行, 补丁按 id 升序重算', async () => {
    seed([
      row(1, { patch_id: 30 }),
      row(2, { patch_id: 10 }),
      row(3, { patch_id: 30 })
    ])

    await remove([3, 1, 2])

    expect(rec.argsOf(RESOURCE_LOCK)).toEqual([[[3, 1, 2]]])
    expect(rec.argsOf('patch_resource.deleteMany')).toEqual([
      { where: { id: { in: [1, 2, 3] } } }
    ])
    expect(
      rec
        .argsOf('patch.update')
        .map((args) => (args as { where: { id: number } }).where.id)
    ).toEqual([10, 30])
  })

  // 计数触发器是行级的: 不预锁的话, patch 行的加锁顺序跟着资源行走 (这里是 30 → 10),
  // 另一批资源行不相交、补丁顺序相反的删除会与它互等。升序由语句里的 ORDER BY 保证
  it('第一条清理语句之前, 一条语句锁住全部涉及的 patch 行', async () => {
    seed([
      row(1, { patch_id: 30 }),
      row(2, { patch_id: 10 }),
      row(3, { patch_id: 30 })
    ])

    await remove([1, 2, 3])

    const [[patchIds]] = rec.argsOf(PATCH_LOCK) as number[][][]
    expect([...patchIds].sort((a, b) => a - b)).toEqual([10, 30])
    const labels = rec.labels()
    expect(labels.indexOf(PATCH_LOCK)).toBe(2)
    expect(labels.indexOf(PATCH_LOCK)).toBeLessThan(
      labels.indexOf('patch_resource.deleteMany')
    )
  })
})

describe('收回发布奖励', () => {
  // 锁序 user → 资源行, 与审核裁决一致; 资源行在前会与它互等
  it('refundPublishReward 为 true 时先锁作者行再锁资源行, 删除之后才扣分', async () => {
    seed([row(1)])

    await remove([1], { refundPublishReward: true })

    const labels = shortLabels()
    expect(labels.slice(0, 2)).toEqual([USER_LOCK, RESOURCE_LOCK])
    expect(labels.indexOf('patch_resource.deleteMany')).toBeLessThan(
      labels.indexOf('user.update')
    )
    expect(rec.argsOf('user.update')).toEqual([
      { where: { id: 7 }, data: { moemoepoint: { increment: -3 } } }
    ])
    expect(userSessionMock.mock.calls).toEqual([[7]])
  })

  it('同一作者的多个资源合并扣分, 作者按 id 升序', async () => {
    seed([row(1, { user_id: 9 }), row(2), row(3)])

    await remove([1, 2, 3], { refundPublishReward: true })

    expect(rec.argsOf('user.update')).toEqual([
      { where: { id: 7 }, data: { moemoepoint: { increment: -6 } } },
      { where: { id: 9 }, data: { moemoepoint: { increment: -3 } } }
    ])
  })

  it('refundPublishReward 为 false 时不锁作者行、不扣分', async () => {
    seed([row(1)])

    await remove([1], { refundPublishReward: false })

    expect(rec.labels()).not.toContain(USER_LOCK)
    expect(rec.labels()).not.toContain('user.update')
    expect(userSessionMock).not.toHaveBeenCalled()
  })

  // 守卫没过时一条写入都没有, 不需要靠回滚把先行的扣分撤回来
  it('守卫未通过时不扣分', async () => {
    seed([row(1, { status: 1 })])

    const { plan } = await remove([1], {
      guard: { statusIn: [0] },
      refundPublishReward: true
    })

    expect(plan.skipped).toEqual([{ id: 1, reason: 'status', status: 1 }])
    expect(rec.labels()).toEqual([
      USER_LOCK,
      RESOURCE_LOCK,
      'patch_resource.findMany'
    ])
    expect(userSessionMock).not.toHaveBeenCalled()
  })
})

describe('守卫在行锁下判定', () => {
  it.each([
    ['已上线', 0],
    ['已隐藏', 1],
    ['待审核', 3]
  ])(
    '状态不在 statusIn 里 (%s) 时跳过: 不清理、不删除、不入箱',
    async (_label, status) => {
      seed([row(1, { status })], [1])

      const { plan, deletedIds } = await remove([1], {
        guard: { statusIn: [2] },
        refundPublishReward: false
      })

      expect(plan.rows).toEqual([])
      expect(plan.skipped).toEqual([{ id: 1, reason: 'status', status }])
      expect(deletedIds).toEqual([])
      // 资源保留时, 它评论区的通知、任务、申诉、举报都要留着
      expect(rec.labels()).toEqual([RESOURCE_LOCK, 'patch_resource.findMany'])
      expect(kickS3Mock).not.toHaveBeenCalled()
      expect(kickSearchMock).not.toHaveBeenCalled()
      expect(patchContentMock).not.toHaveBeenCalled()
    }
  )

  it('行已不存在时报 gone, 不再读行', async () => {
    seed([])

    const { plan } = await remove([1], {
      guard: { statusIn: [0] },
      refundPublishReward: false
    })

    expect(plan.skipped).toEqual([{ id: 1, reason: 'gone' }])
    expect(rec.labels()).toEqual([RESOURCE_LOCK])
  })

  it('ownerUid 不是作者时报 owner', async () => {
    seed([row(1)])

    const { plan } = await remove([1], {
      guard: { statusIn: [0], ownerUid: 8 },
      refundPublishReward: false
    })

    expect(plan.skipped).toEqual([{ id: 1, reason: 'owner' }])
  })

  // 后台删除不设守卫: 隐藏、待审的资源都能删
  it('不传守卫时任何状态都删', async () => {
    seed([row(1, { status: 1 }), row(2, { status: 2 }), row(3, { status: 3 })])

    const { plan, deletedIds } = await remove([1, 2, 3])

    expect(plan.skipped).toEqual([])
    expect(deletedIds).toEqual([1, 2, 3])
  })
})

describe('提交后的副作用', () => {
  it('删除公开的 patch 资源: 补丁聚合、资源详情、资源列表缓存都失效, 两个出箱各踢一次', async () => {
    seed([row(1)])

    await remove([1])

    expect(patchContentMock.mock.calls).toEqual([['patch-10']])
    expect(resourceDetailMock.mock.calls).toEqual([[10]])
    expect(resourceListMock).toHaveBeenCalledTimes(1)
    expect(pendingResourceMock).not.toHaveBeenCalled()
    expect(kickSearchMock).toHaveBeenCalledTimes(1)
    expect(kickS3Mock).toHaveBeenCalledTimes(1)
  })

  it('公开的 galgame 资源不在资源列表里, 不失效列表缓存', async () => {
    seed([row(1, { section: 'galgame' })])

    await remove([1])

    expect(resourceDetailMock.mock.calls).toEqual([[10]])
    expect(resourceListMock).not.toHaveBeenCalled()
  })

  // 初审拒绝与申诉驳回的守卫删除: 行不在公开集里
  it.each([
    ['待初审', 2, true],
    ['待审核', 3, true],
    ['已隐藏', 1, false]
  ])(
    '删除%s的资源: 不失效资源详情与列表缓存',
    async (_label, status, pending) => {
      seed([row(1, { status })])

      await remove([1])

      expect(resourceDetailMock).not.toHaveBeenCalled()
      expect(resourceListMock).not.toHaveBeenCalled()
      // 作者的「有待审资源」标记可能翻假
      expect(pendingResourceMock.mock.calls).toEqual(pending ? [[7]] : [])
      // 补丁聚合跟随重算, 照常失效
      expect(patchContentMock.mock.calls).toEqual([['patch-10']])
    }
  )

  it('批量删除: 每个补丁的聚合缓存失效一次, 出箱各只踢一次', async () => {
    seed([row(1), row(2, { patch_id: 20 }), row(3)])

    await remove([1, 2, 3])

    expect(patchContentMock.mock.calls).toEqual([['patch-10'], ['patch-20']])
    expect(resourceDetailMock.mock.calls).toEqual([[10], [20]])
    expect(kickSearchMock).toHaveBeenCalledTimes(1)
    expect(kickS3Mock).toHaveBeenCalledTimes(1)
  })

  it('事务回滚时没有任何提交后副作用', async () => {
    seed([row(1)])

    const result = await kunTx('probe', async (ctx) => {
      const plan = await planResourceRemoval(ctx, [1], {
        refundPublishReward: true
      })
      await executeResourceRemoval(ctx, plan)
      return ctx.fail('后续步骤失败')
    })

    expect(result).toBe('后续步骤失败')
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(patchContentMock).not.toHaveBeenCalled()
    expect(userSessionMock).not.toHaveBeenCalled()
    expect(kickS3Mock).not.toHaveBeenCalled()
    expect(kickSearchMock).not.toHaveBeenCalled()
  })
})
