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

import { deleteResource } from '~/app/api/patch/resource/delete'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { deleteResource as adminDeleteResource } from '~/app/api/admin/resource/delete'
import {
  resourceLink,
  resourceRow,
  s3EnqueuedKeys,
  seedResourceRemoval,
  shortResourceLabels
} from '~/server/content/resource/__tests__/removalFixture'
import type { ResourceRowFixture } from '~/server/content/resource/__tests__/removalFixture'

// snapshotStatus 是事务外预检读到的状态; lockedRows 是行锁下重读到的
const seed = (snapshotStatus: number, lockedRows: ResourceRowFixture[]) => {
  rec.on('patch_resource.findUnique', {
    id: 1,
    user_id: 7,
    status: snapshotStatus
  })
  seedResourceRemoval(rec, lockedRows, [1])
}

const logContent = () =>
  (rec.argsOf('admin_log.create')[0] as { data: { content: string } }).data
    .content

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  rec.on('user.findUnique', { id: 9, name: 'Admin' })
})

// 失效闸门读行锁下重读的行而非事务外快照: 两者之间存在并发的初审通过 / 隐藏窗口
describe('删除资源按删除瞬间状态分派缓存失效', () => {
  it('删除 section=galgame 的公开资源只失效详情缓存', async () => {
    seed(0, [resourceRow(1, { section: 'galgame' })])

    await deleteResource({ resourceId: 1 }, kunTestActor({ uid: 7, role: 2 }))

    expect(resourceDetailMock.mock.calls).toEqual([[10]])
    expect(resourceListMock).not.toHaveBeenCalled()
  })

  it('删除 section=patch 的公开资源两个缓存都失效', async () => {
    seed(0, [resourceRow(1)])

    await deleteResource({ resourceId: 1 }, kunTestActor({ uid: 7, role: 2 }))

    expect(resourceDetailMock.mock.calls).toEqual([[10]])
    expect(resourceListMock).toHaveBeenCalledTimes(1)
  })

  // 快照 status=2, 并发的初审通过提交后该行已是 0: 管理员删掉的是公开行
  it('快照为待初审但删除时已通过审核, 仍失效详情缓存', async () => {
    seed(2, [resourceRow(1, { section: 'galgame' })])

    await deleteResource({ resourceId: 1 }, kunTestActor({ uid: 9, role: 3 }))

    expect(resourceDetailMock.mock.calls).toEqual([[10]])
    expect(pendingResourceMock).not.toHaveBeenCalled()
  })

  it('删除待审核资源失效作者的 pending 缓存而非详情缓存', async () => {
    seed(3, [resourceRow(1, { status: 3 })])

    await deleteResource({ resourceId: 1 }, kunTestActor({ uid: 9, role: 3 }))

    expect(resourceDetailMock).not.toHaveBeenCalled()
    expect(resourceListMock).not.toHaveBeenCalled()
    expect(pendingResourceMock.mock.calls).toEqual([[7]])
  })

  // 管理端无守卫: 锁下重读为 0 (并发的初审通过已提交) 即失效详情而非 pending
  it('管理员删除同样按锁下重读的删除瞬间状态判定', async () => {
    seed(2, [resourceRow(1)])

    await adminDeleteResource({ resourceIds: [1] }, 9)

    expect(resourceDetailMock.mock.calls).toEqual([[10]])
    expect(pendingResourceMock).not.toHaveBeenCalled()
  })

  it('补丁聚合缓存、搜索出箱与 S3 出箱都在提交之后处理', async () => {
    seed(0, [resourceRow(1)])
    const seenCommitted: boolean[] = []
    const record = async () => {
      seenCommitted.push(rec.attempts[0].committed)
    }
    patchContentMock.mockImplementation(record)
    kickSearchMock.mockImplementation(record)
    kickS3Mock.mockImplementation(record)

    await deleteResource({ resourceId: 1 }, kunTestActor({ uid: 7, role: 2 }))

    expect(patchContentMock.mock.calls).toEqual([['patch-10']])
    expect(kickSearchMock).toHaveBeenCalledTimes(1)
    expect(kickS3Mock).toHaveBeenCalledTimes(1)
    expect(seenCommitted).toEqual([true, true, true])
  })
})

// S3 入队与审计的事实源是行锁下重读的集合: 事务外快照与行锁之间的并发重绑会
// 换 s3_key, 级联删除绕过应用层, 用快照入队会让新对象永不进删除出箱
describe('资源删除以锁下重读的 links 入队 S3 删除', () => {
  it('入队集合来自锁下重读的链接, 只收 s3 存储的', async () => {
    seed(0, [
      resourceRow(1, {
        links: [resourceLink(5, 's3'), resourceLink(6, 'user')]
      })
    ])

    await deleteResource({ resourceId: 1 }, kunTestActor({ uid: 7, role: 2 }))

    expect(s3EnqueuedKeys(rec)).toEqual([['k-5']])
  })

  it('管理员删除的入队与审计都取锁下重读的行', async () => {
    seed(0, [
      resourceRow(1, { name: 'renamed', links: [resourceLink(5, 's3')] })
    ])

    await adminDeleteResource({ resourceIds: [1] }, 9)

    expect(s3EnqueuedKeys(rec)).toEqual([['k-5']])
    expect(logContent()).toContain('renamed')
    // 审计里的链接已脱敏
    expect(logContent()).not.toContain('k-5')
    expect(logContent()).not.toContain('c-5')
  })
})

describe('资源删除的清理顺序', () => {
  // 资源评论随外键级联删除: 评论区的站内信、评论的审核任务与申诉须在删除前清;
  // 举报外键是 SET NULL, 孤儿举报在删除后按 NULL 目标清;
  // 资源自身的审核任务与申诉 content_id 无外键, 级联带不走, 须显式清理
  it('用户删除: 评论派生物在删除前, 资源自身的任务 / 申诉与孤儿举报在删除后', async () => {
    seed(0, [resourceRow(1)])

    await deleteResource({ resourceId: 1 }, kunTestActor({ uid: 7, role: 2 }))

    expect(shortResourceLabels(rec)).toEqual([
      // 收回奖励的入口先读作者、锁作者行
      'patch_resource.findMany',
      'lock user',
      'lock resource',
      'patch_resource.findMany',
      'lock patch',
      'patch_resource.findMany',
      'user_message.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_resource.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_report.deleteMany',
      'user.update',
      'lock patch',
      'recalc.lock',
      'patch_resource.findMany',
      'patch.update',
      'search_outbox.enqueue',
      's3_deletion_outbox.enqueue'
    ])
    expect(rec.argsOf('moderation_appeal.deleteMany')).toEqual([
      {
        where: {
          content_type: 'comment',
          content_id: { in: [100] },
          status: 'pending'
        }
      },
      {
        where: {
          content_type: 'resource',
          content_id: { in: [1] },
          status: 'pending'
        }
      }
    ])
    expect(rec.argsOf('patch_report.deleteMany')).toEqual([
      { where: { target_type: 'comment', status: 0, comment_id: null } }
    ])
  })
})
