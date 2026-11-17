import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)
const { commentPageMock, patchContentMock, onCommentPublishedMock } =
  vi.hoisted(() => ({
    commentPageMock: vi.fn(),
    patchContentMock: vi.fn(),
    onCommentPublishedMock: vi.fn()
  }))

vi.mock('~/prisma/index', () => rec.module)
// submit.ts 读审核配置要连 Redis; 这里只用到它的 deletePendingModerationTasks
vi.mock('~/server/moderation/config', () => ({ getModerationConfig: vi.fn() }))
vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: commentPageMock
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
  onCommentPublished: onCommentPublishedMock
}))

import { kunTx } from '~/server/db/tx'
import { transitionComments } from '~/server/content/comment/transition'

const LOCK =
  '$queryRaw: SELECT id, patch_id, resource_id, status FROM patch_comment WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE'

const row = (id: number, status: number, resourceId: number | null = null) => ({
  id,
  patch_id: 10,
  resource_id: resourceId,
  status
})

const transition = (
  ids: number[],
  options: Parameters<typeof transitionComments>[2]
) => kunTx('probe', (ctx) => transitionComments(ctx, ids, options))

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('评论状态迁移', () => {
  // 先锁行、再对锁下实际迁移的行作废任务: 反过来的话, 作废的是事务外快照里的行
  it('锁行 → 写 status → 作废在途任务, 任务保留 dry_run', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 0)])

    const moved = await transition([5], {
      from: [0, 1],
      to: 2,
      openTasks: 'cancel-keep-dry-run'
    })

    expect(moved).toEqual([{ id: 5, from: 0 }])
    expect(rec.attempts[0].committed).toBe(true)
    expect(rec.labels()).toEqual([
      LOCK,
      'patch_comment.updateMany',
      'moderation_task.deleteMany'
    ])
    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      {
        where: { id: { in: [5] }, status: { in: [0, 1] } },
        data: { status: 2 }
      }
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      {
        where: {
          content_type: 'comment',
          content_id: { in: [5] },
          status: { in: ['pending', 'manual'] },
          dry_run: false
        }
      }
    ])
  })

  it("openTasks 为 'keep' 时不碰任务", async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 1)])

    await transition([5], { from: [1], to: 0, openTasks: 'keep' })

    expect(rec.labels()).toEqual([LOCK, 'patch_comment.updateMany'])
  })

  it('只迁移锁下状态在 from 里的行, 返回它们迁移前的状态', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(1, 0), row(2, 2), row(3, 1)])

    const moved = await transition([3, 1, 2, 4], {
      from: [0, 1],
      to: 2,
      openTasks: 'cancel-keep-dry-run'
    })

    expect(moved).toEqual([
      { id: 1, from: 0 },
      { id: 3, from: 1 }
    ])
    // 已是目标状态的 2 与不存在的 4 不动; 作废任务的集合就是迁移的集合
    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      {
        where: { id: { in: [1, 3] }, status: { in: [0, 1] } },
        data: { status: 2 }
      }
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({ content_id: { in: [1, 3] } })
      })
    ])
  })

  it('没有行可迁移时只有取锁语句, 不登记任何副作用', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 2)])

    const moved = await transition([5], {
      from: [0, 1],
      to: 2,
      openTasks: 'cancel-keep-dry-run'
    })

    expect(moved).toEqual([])
    expect(rec.labels()).toEqual([LOCK])
    expect(commentPageMock).not.toHaveBeenCalled()
  })

  it('data 里的字段随状态一起写', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 2)])

    await transition([5], {
      from: [2],
      to: 0,
      data: { content: '改过的评论', edit: '123' },
      openTasks: 'keep'
    })

    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      {
        where: { id: { in: [5] }, status: { in: [2] } },
        data: { content: '改过的评论', edit: '123', status: 0 }
      }
    ])
  })
})

describe('评论状态迁移的提交后副作用', () => {
  it.each([
    // [名称, 迁移前, 迁移后, 分页缓存, 详情缓存, 补发通知]
    ['待审通过', 1, 0, true, true, true],
    ['隐藏恢复', 2, 0, true, true, true],
    ['公开评论被隐藏', 0, 2, true, true, false],
    // 待审评论本就不在公开基线里
    ['待审被拒', 1, 2, false, false, false]
  ] as const)('%s', async (_name, from, to, page, detail, published) => {
    rec.onRaw(/FOR UPDATE$/, [row(5, from)])

    await transition([5], { from: [from], to, openTasks: 'keep' })

    expect(commentPageMock.mock.calls).toEqual(page ? [[10]] : [])
    expect(patchContentMock.mock.calls).toEqual(detail ? [[[10]]] : [])
    expect(onCommentPublishedMock.mock.calls).toEqual(published ? [[5]] : [])
  })

  it('资源评论转公开: 不失效补丁详情缓存, 通知照发', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 1, 42)])

    await transition([5], { from: [1], to: 0, openTasks: 'keep' })

    expect(commentPageMock.mock.calls).toEqual([[10]])
    expect(patchContentMock).not.toHaveBeenCalled()
    expect(onCommentPublishedMock.mock.calls).toEqual([[5]])
  })

  it('事务回滚时没有任何副作用', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(5, 1)])

    const result = await kunTx('probe', async (ctx) => {
      await transitionComments(ctx, [5], {
        from: [1],
        to: 0,
        openTasks: 'keep'
      })
      return ctx.fail('后续步骤失败')
    })

    expect(result).toBe('后续步骤失败')
    expect(commentPageMock).not.toHaveBeenCalled()
    expect(onCommentPublishedMock).not.toHaveBeenCalled()
  })
})
