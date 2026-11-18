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

import { deleteResource } from '~/app/api/admin/resource/delete'
import {
  resourceLink,
  resourceRow,
  s3EnqueuedKeys,
  seedResourceRemoval,
  shortResourceLabels
} from '~/server/content/resource/__tests__/removalFixture'

const deadlock = () =>
  Object.assign(new Error('deadlock detected'), {
    code: 'P2010',
    meta: {
      driverAdapterError: { cause: { kind: 'postgres', originalCode: '40P01' } }
    }
  })

// 默认的三条: 1 公开 patch (作者 5)、2 待初审 galgame (作者 6)、3 隐藏 patch (作者 7, 在补丁 20)
const defaultRows = () => [
  resourceRow(1, { user_id: 5 }),
  resourceRow(2, {
    user_id: 6,
    status: 2,
    section: 'galgame',
    links: [resourceLink(21, 's3')]
  }),
  resourceRow(3, { user_id: 7, patch_id: 20, status: 1, links: [] })
]

const logContent = () =>
  (rec.argsOf('admin_log.create')[0] as { data: { content: string } }).data
    .content

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  rec.on('user.findUnique', { id: 99, name: 'admin' })
  seedResourceRemoval(rec, defaultRows(), [1])
})

describe('deleteResource 批量删除', () => {
  it('一条升序 FOR UPDATE 锁全部行, 单次 deleteMany, 派生清理整批一次', async () => {
    await expect(
      deleteResource({ resourceIds: [3, 1, 2] }, 99)
    ).resolves.toEqual({ count: 3 })

    expect(rec.attempts).toHaveLength(1)
    const lock = rec.labels()[0]
    expect(lock).toBe(
      '$queryRaw: SELECT id FROM patch_resource WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE'
    )
    expect(rec.argsOf(lock)).toEqual([[[3, 1, 2]]])
    // 后台删除不收回发布奖励: 不锁作者行、不扣分
    expect(shortResourceLabels(rec)).toEqual([
      'lock resource',
      // 锁下重读的集合 (而非入参) 是删除与派生清理的事实源
      'patch_resource.findMany',
      // 一条语句升序锁住补丁 10、20 的行, 排在第一条写语句之前
      'lock patch',
      'patch.findMany',
      // 评论派生清理整批一次, 且在行删除之前 (评论行尚存时)
      'patch_resource.findMany',
      'user_message.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_resource.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_report.deleteMany',
      // 补丁 10、20 各重算一次: patch 行 → 通告锁
      'lock patch',
      'recalc.lock',
      'patch_resource.findMany',
      'patch.update',
      'lock patch',
      'recalc.lock',
      'patch_resource.findMany',
      'patch.update',
      'search_outbox.enqueue',
      's3_deletion_outbox.enqueue',
      'admin_log.create'
    ])
    expect(rec.argsOf('patch_resource.deleteMany')).toEqual([
      { where: { id: { in: [1, 2, 3] } } }
    ])
    expect(userSessionMock).not.toHaveBeenCalled()
  })

  it('patch 通告锁与搜索入箱按 patchId 去重升序, S3 仅入队 s3 链接', async () => {
    seedResourceRemoval(rec, [
      resourceRow(1, { patch_id: 20, links: [resourceLink(11, 's3')] }),
      resourceRow(2, { patch_id: 10, links: [resourceLink(21, 'user')] }),
      resourceRow(3, { patch_id: 20, links: [resourceLink(31, 's3')] })
    ])

    await deleteResource({ resourceIds: [1, 2, 3] }, 99)

    expect(
      rec
        .argsOf('patch.update')
        .map((args) => (args as { where: { id: number } }).where.id)
    ).toEqual([10, 20])
    const enqueue = rec
      .labels()
      .find((label) => label.includes('INSERT INTO search_outbox')) as string
    expect(rec.argsOf(enqueue)).toEqual([[[10, 20]]])
    // 入队在事务内 (审计日志之前), 与行删除原子提交
    expect(s3EnqueuedKeys(rec)).toEqual([['k-11', 'k-31']])
  })

  it('提交后失效沿用单删闸门: 仅 status=0 的 patch 失效详情, section=patch 才失效列表, 2/3 失效作者 pending', async () => {
    await deleteResource({ resourceIds: [1, 2, 3] }, 99)

    expect(patchContentMock.mock.calls).toEqual([['patch-10'], ['patch-20']])
    // 资源 3 (补丁 20) 删除时 status=1, 不在详情集合里
    expect(resourceDetailMock.mock.calls).toEqual([[10]])
    expect(resourceListMock).toHaveBeenCalledTimes(1)
    // 仅资源 2 (status=2, 作者 6) 触发 pending 失效
    expect(pendingResourceMock.mock.calls).toEqual([[6]])
    expect(kickSearchMock).toHaveBeenCalledTimes(1)
    expect(kickS3Mock).toHaveBeenCalledTimes(1)
  })

  it('被删行均非 status=0 时不失效详情与列表', async () => {
    seedResourceRemoval(rec, [
      resourceRow(1, { user_id: 5, status: 1 }),
      resourceRow(2, { user_id: 6, status: 3 })
    ])

    await expect(deleteResource({ resourceIds: [1, 2] }, 99)).resolves.toEqual({
      count: 2
    })

    expect(resourceDetailMock).not.toHaveBeenCalled()
    expect(resourceListMock).not.toHaveBeenCalled()
    expect(pendingResourceMock.mock.calls).toEqual([[6]])
  })

  it('锁到 0 行返回业务错误且无任何写入', async () => {
    seedResourceRemoval(rec, [])

    await expect(deleteResource({ resourceIds: [1, 2, 3] }, 99)).resolves.toBe(
      '未找到对应的资源'
    )

    expect(shortResourceLabels(rec)).toEqual(['lock resource'])
    expect(patchContentMock).not.toHaveBeenCalled()
    expect(kickSearchMock).not.toHaveBeenCalled()
    expect(kickS3Mock).not.toHaveBeenCalled()
  })

  it('单条删除保持原有全量快照审计格式, 敏感链接字段已脱敏', async () => {
    seedResourceRemoval(rec, [
      resourceRow(1, { links: [resourceLink(11, 's3')] })
    ])

    await expect(deleteResource({ resourceIds: [1] }, 99)).resolves.toEqual({
      count: 1
    })

    const content = logContent()
    expect(content).toContain('管理员 admin 删除了一个资源')
    expect(content).toContain('Galgame 名:\nname-10')
    expect(content).toContain('资源信息:')
    expect(content).toContain('"name":"resource-1"')
    expect(content).not.toContain('c-11')
    expect(content).not.toContain('k-11')
    expect(content).not.toContain('"password"')
  })

  it('批量审计日志记录全部 id 与前 10 条摘要', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1)
    seedResourceRemoval(
      rec,
      ids.map((id) => resourceRow(id, { links: [resourceLink(id * 10, 's3')] }))
    )

    await deleteResource({ resourceIds: ids }, 99)

    const content = logContent()
    expect(content).toContain('管理员 admin 批量删除了 12 条资源')
    expect(content).toContain(`资源 ID: ${ids.join(', ')}`)
    expect(content).toContain('其余 2 条资源摘要已省略')
    expect(content).toContain('"patchName":"name-10"')
    expect(content).toContain('"linkCount":1')
    expect(content).not.toContain('"content"')
  })

  it('事务超时上调至 60s, 整批共用一个事务', async () => {
    await deleteResource({ resourceIds: [1, 2, 3] }, 99)

    expect(rec.attempts).toHaveLength(1)
    expect(rec.attempts[0].options).toEqual({ timeout: 60000 })
  })

  it('40P01 冲突重试整个事务, 提交后的副作用只按最终一次的结果执行', async () => {
    let lockCalls = 0
    rec.on('admin_log.create', () => {
      lockCalls++
      if (lockCalls === 1) {
        throw deadlock()
      }
      return {}
    })

    await expect(
      deleteResource({ resourceIds: [1, 2, 3] }, 99)
    ).resolves.toEqual({ count: 3 })

    expect(rec.attempts.map((attempt) => attempt.committed)).toEqual([
      false,
      true
    ])
    expect(patchContentMock.mock.calls).toEqual([['patch-10'], ['patch-20']])
    expect(kickSearchMock).toHaveBeenCalledTimes(1)
    expect(kickS3Mock).toHaveBeenCalledTimes(1)
  })

  it('非冲突错误不重试直接抛出', async () => {
    rec.on('admin_log.create', () => {
      throw new Error('boom')
    })

    await expect(
      deleteResource({ resourceIds: [1, 2, 3] }, 99)
    ).rejects.toThrow('boom')

    expect(rec.attempts).toHaveLength(1)
    expect(kickSearchMock).not.toHaveBeenCalled()
  })

  it('连续 3 次冲突后放弃', async () => {
    rec.on('admin_log.create', () => {
      throw deadlock()
    })

    await expect(
      deleteResource({ resourceIds: [1, 2, 3] }, 99)
    ).rejects.toThrow('deadlock detected')

    expect(rec.attempts).toHaveLength(3)
    expect(kickS3Mock).not.toHaveBeenCalled()
  })

  it('管理员不存在', async () => {
    rec.on('user.findUnique', null)

    expect(await deleteResource({ resourceIds: [1] }, 99)).toBe(
      '未找到该管理员'
    )
    expect(rec.attempts).toHaveLength(0)
  })
})
