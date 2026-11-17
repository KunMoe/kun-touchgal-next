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

import { updateResourceHidden } from '~/app/api/admin/resource/hidden/hidden'

const row = (
  id: number,
  patchId: number,
  status: number,
  section = 'patch'
) => ({ id, user_id: 7, patch_id: patchId, status, section })

// 行锁下读到的资源行
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
      label.includes('FOR UPDATE')
        ? 'lock resource'
        : label.includes('FROM patch WHERE')
          ? 'lock patch'
          : label.includes('pg_advisory_xact_lock')
            ? 'recalc.lock'
            : label.includes('INSERT INTO search_outbox')
              ? 'search_outbox.enqueue'
              : label
    )

const logContent = () =>
  (rec.argsOf('admin_log.create')[0] as { data: { content: string } }).data
    .content

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  rec.on('user.findUnique', { id: 99, name: 'admin' })
})

describe('updateResourceHidden', () => {
  it('管理员不存在', async () => {
    rec.on('user.findUnique', null)

    expect(
      await updateResourceHidden({ resourceIds: [1], status: 1 }, 99)
    ).toBe('未找到该管理员')
    expect(rec.attempts).toHaveLength(0)
  })

  it('没有可流转的资源时返回 0, 不写审计、不失效缓存', async () => {
    seed([row(1, 10, 1), row(2, 10, 3)])

    expect(
      await updateResourceHidden({ resourceIds: [1, 2], status: 1 }, 99)
    ).toEqual({ count: 0 })
    expect(shortLabels()).toEqual(['lock resource'])
    expect(resourceListMock).not.toHaveBeenCalled()
    expect(kickSearchMock).not.toHaveBeenCalled()
  })

  // 锁序: 资源行 → 审核任务, 与审核裁决、删除一致
  it('隐藏: 先锁资源行, 只从正常态流转, 再作废在途任务 (保留 dry_run), 重算聚合并入搜索出箱', async () => {
    seed([row(1, 20, 0), row(2, 10, 0), row(3, 20, 0)])

    const result = await updateResourceHidden(
      { resourceIds: [1, 2, 3], status: 1 },
      99
    )

    expect(result).toEqual({ count: 3 })
    expect(shortLabels()).toEqual([
      'lock resource',
      // 写 status 之前一条语句升序锁住补丁 10、20 的行
      'lock patch',
      'patch_resource.updateMany',
      'moderation_task.deleteMany',
      // 补丁按 id 升序: 10 再 20; 每次重算都是 patch 行 → 通告锁
      'lock patch',
      'recalc.lock',
      'patch_resource.findMany',
      'patch.update',
      'lock patch',
      'recalc.lock',
      'patch_resource.findMany',
      'patch.update',
      'search_outbox.enqueue',
      'admin_log.create'
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      {
        where: {
          content_type: 'resource',
          content_id: { in: [1, 2, 3] },
          status: { in: ['pending', 'manual'] },
          dry_run: false
        }
      }
    ])
    expect(rec.argsOf('patch_resource.updateMany')).toEqual([
      {
        where: { id: { in: [1, 2, 3] }, status: { in: [0] } },
        data: { status: 1 }
      }
    ])
    expect(
      rec
        .argsOf('patch.update')
        .map((args) => (args as { where: { id: number } }).where.id)
    ).toEqual([10, 20])
    expect(logContent()).toBe(
      '管理员 admin 批量将 3 条资源状态修改为 隐藏\n资源 ID: 1, 2, 3'
    )
  })

  it('取消隐藏: 只从隐藏态流转', async () => {
    seed([row(1, 10, 1)])

    await updateResourceHidden({ resourceIds: [1], status: 0 }, 99)

    expect(rec.argsOf('patch_resource.updateMany')).toEqual([
      { where: { id: { in: [1] }, status: { in: [1] } }, data: { status: 0 } }
    ])
    expect(logContent()).toContain('状态修改为 正常')
  })

  // 事务外读到的状态与行锁之间隔着一个窗口: 其间资源 2 被作者编辑送审 (0→3)。
  // 以前按快照作废任务再条件更新, 2 的新任务被作废而行仍是待审核 (卡死),
  // 且照样报「3 条已隐藏」
  it('只对行锁下仍可流转的资源作废任务, 返回值与审计都是实际迁移的条数', async () => {
    seed([row(1, 10, 0), row(2, 10, 3), row(3, 10, 0)])

    const result = await updateResourceHidden(
      { resourceIds: [1, 2, 3], status: 1 },
      99
    )

    expect(result).toEqual({ count: 2 })
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({ content_id: { in: [1, 3] } })
      })
    ])
    expect(logContent()).toBe(
      '管理员 admin 批量将 2 条资源状态修改为 隐藏\n资源 ID: 1, 3'
    )
  })

  it('提交后失效补丁聚合与资源详情缓存, 搜索出箱只踢一次', async () => {
    seed([row(1, 20, 0, 'galgame'), row(2, 10, 0, 'galgame')])
    const seenCommitted: boolean[] = []
    patchContentMock.mockImplementation(async () => {
      seenCommitted.push(rec.attempts[0].committed)
    })

    await updateResourceHidden({ resourceIds: [1, 2], status: 1 }, 99)

    expect(patchContentMock.mock.calls).toEqual([['patch-10'], ['patch-20']])
    expect(seenCommitted).toEqual([true, true])
    expect(resourceDetailMock.mock.calls).toEqual([[10], [20]])
    expect(kickSearchMock).toHaveBeenCalledTimes(1)
    // 资源列表只列 section=patch 的资源
    expect(resourceListMock).not.toHaveBeenCalled()
  })

  it('迁移的资源里有 section=patch 的才失效资源列表缓存', async () => {
    seed([row(1, 10, 0, 'patch')])

    await updateResourceHidden({ resourceIds: [1], status: 1 }, 99)

    expect(resourceListMock).toHaveBeenCalledTimes(1)
  })
})
