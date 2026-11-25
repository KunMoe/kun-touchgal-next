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

import { deleteResource } from '~/app/api/patch/resource/delete'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import {
  resourceRow,
  seedResourceRemoval,
  shortResourceLabels
} from '~/server/content/resource/__tests__/removalFixture'
import type { ResourceRowFixture } from '~/server/content/resource/__tests__/removalFixture'

// snapshot 是事务外预检读到的行; lockedRows 是行锁下重读到的
const seed = (
  snapshot: { id: number; user_id: number; status: number } | null,
  lockedRows: ResourceRowFixture[]
) => {
  rec.on('patch_resource.findUnique', snapshot)
  seedResourceRemoval(rec, lockedRows)
}
const snapshot = (status = 0) => ({ id: 1, user_id: 7, status })

const expectNoWrites = () => {
  // 守卫没过时一条写入都没有: 没有扣分, 也就不需要靠回滚把它撤回来
  expect(shortResourceLabels(rec)).toEqual([
    'lock resource',
    'patch_resource.findMany'
  ])
  expect(patchContentMock).not.toHaveBeenCalled()
  expect(resourceDetailMock).not.toHaveBeenCalled()
  expect(resourceListMock).not.toHaveBeenCalled()
  expect(userSessionMock).not.toHaveBeenCalled()
  expect(pendingResourceMock).not.toHaveBeenCalled()
  expect(kickSearchMock).not.toHaveBeenCalled()
  expect(kickS3Mock).not.toHaveBeenCalled()
}

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('删除资源的事务外预检', () => {
  it.each([
    ['资源不存在', null, 7, 2, '未找到对应的资源'],
    // 隐藏的资源仅后台可管理, 前端与不存在等同 (对管理员也一样)
    ['资源已隐藏', snapshot(1), 9, 3, '未找到对应的资源'],
    ['不是作者也不是管理员', snapshot(0), 8, 2, '您没有权限删除该资源'],
    [
      '作者删自己待初审的资源',
      snapshot(2),
      7,
      2,
      '该资源正在审核中, 暂时无法删除'
    ],
    [
      '作者删自己待审核的资源',
      snapshot(3),
      7,
      2,
      '该资源正在审核中, 暂时无法删除'
    ]
  ] as const)('%s', async (_name, row, uid, role, message) => {
    seed(row, [])

    expect(
      await deleteResource({ resourceId: 1 }, kunTestActor({ uid, role }))
    ).toBe(message)
    expect(rec.attempts).toHaveLength(0)
  })
})

// 事务外守卫读的是快照, 与行锁之间隔着等锁的窗口; 行锁的阻塞恰恰保证本事务在
// 并发提交之后才继续, 不复检即物理删除管理员刚隐藏或已送审的行
describe('删除资源在行锁下复检守卫', () => {
  it('快照公开但锁下已被隐藏, 拒绝删除, 不扣分', async () => {
    seed(snapshot(), [resourceRow(1, { status: 1 })])

    const result = await deleteResource(
      { resourceId: 1 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(result).toBe('未找到对应的资源')
    expect(rec.attempts[0].rolledBack).toBe(true)
    expectNoWrites()
  })

  // 前台端点不管理隐藏资源 (与预检语义一致), 复检对管理员同样生效
  it('隐藏复检对管理员同样生效', async () => {
    seed(snapshot(), [resourceRow(1, { status: 1 })])

    const result = await deleteResource(
      { resourceId: 1 },
      kunTestActor({ uid: 9, role: 3 })
    )

    expect(result).toBe('未找到对应的资源')
    expectNoWrites()
  })

  it('快照公开但锁下已转待审核, 非特权作者被拒', async () => {
    seed(snapshot(), [resourceRow(1, { status: 3 })])

    const result = await deleteResource(
      { resourceId: 1 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(result).toBe('该资源正在审核中, 暂时无法删除')
    expect(rec.attempts[0].rolledBack).toBe(true)
    expectNoWrites()
  })

  it('锁下行已被并发删除', async () => {
    seed(snapshot(), [])

    const result = await deleteResource(
      { resourceId: 1 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(result).toBe('未找到对应的资源')
    expect(shortResourceLabels(rec)).toEqual(['lock resource'])
    expect(kickS3Mock).not.toHaveBeenCalled()
  })

  it('锁下待审核不拦管理员, 保持事务外守卫语义', async () => {
    seed(snapshot(3), [resourceRow(1, { status: 3 })])

    const result = await deleteResource(
      { resourceId: 1 },
      kunTestActor({ uid: 9, role: 3 })
    )

    expect(result).toEqual({})
    expect(rec.attempts[0].committed).toBe(true)
    expect(rec.argsOf('patch_resource.deleteMany')).toEqual([
      { where: { id: { in: [1] } } }
    ])
  })
})

describe('删除资源收回发布奖励', () => {
  // 作者的 user 行是最后一层锁 (资源行 → patch 行 → user 行), 与点赞、发布资源同向;
  // 审核裁决对资源只取 user 行的 FOR KEY SHARE, 不与扣分冲突
  it('先锁资源行, 删除之后扣 3 萌萌点并失效作者会话, 不预先锁作者行', async () => {
    seed(snapshot(), [resourceRow(1)])

    const result = await deleteResource(
      { resourceId: 1 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(result).toEqual({})
    const labels = shortResourceLabels(rec)
    expect(labels.slice(0, 2)).toEqual([
      'lock resource',
      'patch_resource.findMany'
    ])
    expect(labels).not.toContain('lock user')
    expect(labels.indexOf('patch_resource.deleteMany')).toBeLessThan(
      labels.indexOf('user.update')
    )
    expect(rec.argsOf('user.update')).toEqual([
      { where: { id: 7 }, data: { moemoepoint: { increment: -3 } } }
    ])
    expect(userSessionMock.mock.calls).toEqual([[7]])
  })

  // 管理员经前台端点删除他人的资源: 扣的是作者的分
  it('管理员删除他人资源时扣作者的分', async () => {
    seed(snapshot(), [resourceRow(1)])

    await deleteResource({ resourceId: 1 }, kunTestActor({ uid: 9, role: 3 }))

    expect(rec.argsOf('user.update')).toEqual([
      { where: { id: 7 }, data: { moemoepoint: { increment: -3 } } }
    ])
  })
})
