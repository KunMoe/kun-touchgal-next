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
// 删除命令与它用到的积木照常执行, 只挡掉它们顶层引入的外部服务
vi.mock('~/lib/s3', () => ({}))
vi.mock('~/lib/redis', () => ({}))
vi.mock('~/lib/meilisearch', () => ({ getMeiliClient: () => null }))
vi.mock('~/server/jobs/lease', () => ({
  withJobLease: vi.fn(async () => ({ ran: false }))
}))
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
import { transitionResources } from '~/server/content/resource/transition'

const LOCK =
  '$queryRaw: SELECT id, user_id, patch_id, status, section FROM patch_resource WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE'

const PATCH_LOCK =
  '$executeRaw: SELECT id FROM patch WHERE id = ANY(?::int[]) ORDER BY id FOR NO KEY UPDATE'

const row = (
  id: number,
  status: number,
  overrides: Record<string, unknown> = {}
) => ({ id, user_id: 7, patch_id: 10, status, section: 'patch', ...overrides })

const seed = (rows: ReturnType<typeof row>[]) => {
  rec.onRaw(/FROM patch_resource .* FOR UPDATE$/, rows)
  // recalcPatchType 读公开资源、写补丁聚合
  rec.on('patch_resource.findMany', [])
  rec.on('patch.update', (args: { where: { id: number } }) => ({
    unique_id: `patch-${args.where.id}`
  }))
}

const shortLabels = () =>
  rec
    .labels()
    .map((label) =>
      label.includes('pg_advisory_xact_lock')
        ? 'recalc.lock'
        : label.includes('INSERT INTO search_outbox')
          ? 'search_outbox.enqueue'
          : label === PATCH_LOCK
            ? 'patch.lock'
            : label
    )

const transition = (
  ids: number[],
  options: Parameters<typeof transitionResources>[2]
) => kunTx('probe', (ctx) => transitionResources(ctx, ids, options))

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('资源状态迁移', () => {
  // 先锁行、再对锁下实际迁移的行作废任务: 反过来的话, 作废的是事务外快照里的行,
  // 与并发的作者编辑交错时会留下「待审核却没有任何在途任务」的资源
  it('锁行 → 锁 patch 行 → 写 status → 作废在途任务 (保留 dry_run) → 重算聚合 → 搜索出箱', async () => {
    seed([row(1, 0)])

    const moved = await transition([1], {
      from: [0],
      to: 1,
      openTasks: 'cancel-keep-dry-run'
    })

    expect(moved).toEqual([{ id: 1, from: 0 }])
    expect(rec.attempts[0].committed).toBe(true)
    expect(shortLabels()).toEqual([
      LOCK,
      // 写 status 会让计数触发器去改 patch 行: 先把它锁住
      'patch.lock',
      'patch_resource.updateMany',
      'moderation_task.deleteMany',
      // recalcPatchType: patch 行 → 通告锁 → 读公开资源 → 写补丁聚合
      'patch.lock',
      'recalc.lock',
      'patch_resource.findMany',
      'patch.update',
      'search_outbox.enqueue'
    ])
    expect(rec.argsOf('patch_resource.updateMany')).toEqual([
      { where: { id: { in: [1] }, status: { in: [0] } }, data: { status: 1 } }
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      {
        where: {
          content_type: 'resource',
          content_id: { in: [1] },
          status: { in: ['pending', 'manual'] },
          dry_run: false
        }
      }
    ])
  })

  it('只迁移锁下状态在 from 里的行; 作废任务的集合就是迁移的集合', async () => {
    // 2 在快照之后被作者编辑送审 (0→3), 不再属于「正常 → 隐藏」
    seed([row(1, 0), row(2, 3), row(3, 0, { patch_id: 20 })])

    const moved = await transition([3, 2, 1], {
      from: [0],
      to: 1,
      openTasks: 'cancel-keep-dry-run'
    })

    expect(moved).toEqual([
      { id: 1, from: 0 },
      { id: 3, from: 0 }
    ])
    expect(rec.argsOf(LOCK)).toEqual([[[3, 2, 1]]])
    expect(rec.argsOf('patch_resource.updateMany')).toEqual([
      {
        where: { id: { in: [1, 3] }, status: { in: [0] } },
        data: { status: 1 }
      }
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({ content_id: { in: [1, 3] } })
      })
    ])
  })

  it('补丁按 id 去重升序重算, 搜索出箱一条语句入整批', async () => {
    seed([
      row(1, 0, { patch_id: 20 }),
      row(2, 0, { patch_id: 10 }),
      row(3, 0, { patch_id: 20 })
    ])

    await transition([1, 2, 3], {
      from: [0],
      to: 1,
      openTasks: 'cancel-keep-dry-run'
    })

    expect(
      rec
        .argsOf('patch.update')
        .map((args) => (args as { where: { id: number } }).where.id)
    ).toEqual([10, 20])
    const enqueue = rec
      .labels()
      .find((label) => label.includes('INSERT INTO search_outbox')) as string
    expect(rec.argsOf(enqueue)).toEqual([[[10, 20]]])
  })

  // 计数触发器是行级的: 不预锁的话, patch 行的加锁顺序跟着资源行走 (这里是 20 → 10),
  // 另一批资源行不相交、补丁顺序相反的迁移会与它互等
  it('写 status 之前一条语句按 patch id 升序锁住全部涉及的 patch 行', async () => {
    seed([
      row(1, 0, { patch_id: 20 }),
      row(2, 0, { patch_id: 10 }),
      row(3, 0, { patch_id: 20 })
    ])

    await transition([1, 2, 3], {
      from: [0],
      to: 1,
      openTasks: 'cancel-keep-dry-run'
    })

    expect(rec.argsOf(PATCH_LOCK)[0]).toEqual([[10, 20]])
    const labels = rec.labels()
    expect(labels.indexOf(PATCH_LOCK)).toBeLessThan(
      labels.indexOf('patch_resource.updateMany')
    )
  })

  it("openTasks 为 'keep' 时不碰任务", async () => {
    seed([row(1, 3)])

    await transition([1], { from: [3], to: 0, openTasks: 'keep' })

    expect(rec.labels()).not.toContain('moderation_task.deleteMany')
  })

  it('没有行可迁移时只有取锁语句, 不重算、不入箱', async () => {
    seed([row(1, 3)])

    expect(
      await transition([1], {
        from: [0],
        to: 1,
        openTasks: 'cancel-keep-dry-run'
      })
    ).toEqual([])
    expect(rec.labels()).toEqual([LOCK])
    expect(kickSearchMock).not.toHaveBeenCalled()
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('data 里的字段随状态一起写', async () => {
    seed([row(1, 1)])

    await transition([1], {
      from: [1],
      to: 0,
      data: { name: '新名字', note: '新备注' },
      openTasks: 'keep'
    })

    expect(rec.argsOf('patch_resource.updateMany')).toEqual([
      {
        where: { id: { in: [1] }, status: { in: [1] } },
        data: { name: '新名字', note: '新备注', status: 0 }
      }
    ])
  })
})

describe('资源状态迁移的提交后副作用', () => {
  it.each([
    // [名称, 迁移前, 迁移后, section, 资源详情, 资源列表, 作者待审标记]
    ['公开资源被隐藏', 0, 1, 'patch', true, true, false],
    ['隐藏资源恢复公开', 1, 0, 'patch', true, true, false],
    ['galgame 资源被隐藏', 0, 1, 'galgame', true, false, false],
    ['待初审通过', 2, 0, 'patch', true, true, true],
    ['待审核通过', 3, 0, 'patch', true, true, true],
    // 待审核与隐藏都不在公开集里
    ['待审核被拒转隐藏', 3, 1, 'patch', false, false, true]
  ] as const)('%s', async (_name, from, to, section, detail, list, pending) => {
    seed([row(1, from, { section })])

    await transition([1], { from: [from], to, openTasks: 'keep' })

    expect(resourceDetailMock.mock.calls).toEqual(detail ? [[10]] : [])
    expect(resourceListMock).toHaveBeenCalledTimes(list ? 1 : 0)
    expect(pendingResourceMock.mock.calls).toEqual(pending ? [[7]] : [])
    // 补丁聚合缓存与搜索出箱跟随重算, 每次迁移都处理
    expect(patchContentMock.mock.calls).toEqual([['patch-10']])
    expect(kickSearchMock).toHaveBeenCalledTimes(1)
  })

  it('副作用都在提交之后', async () => {
    seed([row(1, 0)])
    const seenCommitted: boolean[] = []
    const record = async () => {
      seenCommitted.push(rec.attempts[0].committed)
    }
    patchContentMock.mockImplementation(record)
    kickSearchMock.mockImplementation(record)
    resourceDetailMock.mockImplementation(record)

    await transition([1], {
      from: [0],
      to: 1,
      openTasks: 'cancel-keep-dry-run'
    })

    expect(seenCommitted).toEqual([true, true, true])
  })

  it('事务回滚时没有任何副作用', async () => {
    seed([row(1, 0)])

    const result = await kunTx('probe', async (ctx) => {
      await transitionResources(ctx, [1], {
        from: [0],
        to: 1,
        openTasks: 'cancel-keep-dry-run'
      })
      return ctx.fail('后续步骤失败')
    })

    expect(result).toBe('后续步骤失败')
    expect(patchContentMock).not.toHaveBeenCalled()
    expect(kickSearchMock).not.toHaveBeenCalled()
    expect(resourceDetailMock).not.toHaveBeenCalled()
  })
})
