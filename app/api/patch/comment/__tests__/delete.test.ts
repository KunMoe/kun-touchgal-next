import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)
const { commentPageMock, patchContentMock } = vi.hoisted(() => ({
  commentPageMock: vi.fn(),
  patchContentMock: vi.fn()
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
  onCommentPublished: vi.fn()
}))

import { deleteComment } from '~/app/api/patch/comment/delete'

const locked = (status: number, overrides: Record<string, unknown> = {}) => ({
  id: 11,
  user_id: 7,
  patch_id: 10,
  resource_id: null,
  status,
  ...overrides
})

// snapshot 是事务外预检读到的行; lockedRows 是行锁下重读到的
const seed = (
  snapshot: { id: number; user_id: number; status: number } | null,
  lockedRows: ReturnType<typeof locked>[],
  subtree: ReturnType<typeof locked>[] = lockedRows
) => {
  rec.on('patch_comment.findUnique', snapshot)
  rec.onRaw(/FOR UPDATE$/, lockedRows)
  rec.onRaw(/^WITH RECURSIVE subtree/, subtree)
  rec.on('patch_comment.findMany', () =>
    subtree.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      parent_id: null,
      resource_id: row.resource_id,
      parent: null,
      resource: null,
      patch: { unique_id: 'patch-10' }
    }))
  )
}

const snapshot = (status = 0) => ({ id: 11, user_id: 7, status })

const expectNothingRemoved = () => {
  expect(rec.labels()).not.toContain('patch_comment.deleteMany')
  expect(rec.labels()).not.toContain('user_message.deleteMany')
  expect(rec.labels()).not.toContain('moderation_task.deleteMany')
  expect(commentPageMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('deleteComment 事务外预检', () => {
  it.each([
    ['评论不存在', null, 7, 1, '未找到对应的评论'],
    // 隐藏的评论仅后台可管理, 前端与不存在等同 (对管理员也一样)
    ['评论已隐藏', snapshot(2), 9, 3, '未找到对应的评论'],
    ['不是作者也不是管理员', snapshot(0), 8, 1, '您没有权限删除该评论'],
    [
      '作者删自己待审的评论',
      snapshot(1),
      7,
      1,
      '该评论正在审核中, 暂时无法删除'
    ]
  ])('%s', async (_name, row, uid, role, message) => {
    seed(row, [])

    expect(await deleteComment({ commentId: 11 }, uid, role)).toBe(message)
    expect(rec.attempts).toHaveLength(0)
  })
})

describe('deleteComment 删除', () => {
  it('作者删除自己的公开评论: 连同回复子树的通知、任务、申诉与孤儿举报', async () => {
    seed(snapshot(), [locked(0)], [locked(0), locked(0, { id: 12 })])

    const result = await deleteComment({ commentId: 11 }, 7, 1)

    expect(result).toEqual({})
    expect(rec.attempts[0].committed).toBe(true)
    // 行删除后深链无从重建, 通知清理必须在删除之前; 孤儿举报在删除之后
    expect(
      rec.labels().map((label) => label.replace(/^(\$queryRaw): .*$/, '$1'))
    ).toEqual([
      '$queryRaw',
      '$queryRaw',
      'patch_comment.findMany',
      'user_message.deleteMany',
      'user_message.deleteMany',
      'patch_comment.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_report.deleteMany'
    ])
    // 只删根, 回复随外键级联; 任务按整棵子树清
    expect(rec.argsOf('patch_comment.deleteMany')).toEqual([
      { where: { id: { in: [11] } } }
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({ content_id: { in: [11, 12] } })
      })
    ])
    expect(commentPageMock.mock.calls).toEqual([[10]])
    // 删除评论改变评论数, 失效补丁详情缓存 (M-05)
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
  })

  it('资源评论不计入评论数, 不失效补丁详情缓存', async () => {
    seed(snapshot(), [locked(0, { resource_id: 5 })])

    await deleteComment({ commentId: 11 }, 7, 1)

    expect(commentPageMock.mock.calls).toEqual([[10]])
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('管理员可以删除他人待审的评论', async () => {
    seed(snapshot(1), [locked(1)])

    expect(await deleteComment({ commentId: 11 }, 9, 3)).toEqual({})
    expect(rec.labels()).toContain('patch_comment.deleteMany')
  })
})

// 预检读的是快照, 与事务之间隔着一个窗口: 其间评论被管理员隐藏、被编辑送审,
// 或被别人删掉。同一组条件在行锁下再判一次, 不通过就什么都不动
describe('deleteComment 行锁下复检', () => {
  it('快照公开, 锁下已被隐藏: 与不存在等同', async () => {
    seed(snapshot(), [locked(2)])

    expect(await deleteComment({ commentId: 11 }, 7, 1)).toBe(
      '未找到对应的评论'
    )
    expect(rec.attempts[0].rolledBack).toBe(true)
    expectNothingRemoved()
  })

  it('隐藏复检对管理员同样生效', async () => {
    seed(snapshot(), [locked(2)])

    expect(await deleteComment({ commentId: 11 }, 9, 3)).toBe(
      '未找到对应的评论'
    )
    expectNothingRemoved()
  })

  it('快照公开, 锁下已转待审: 作者被拒', async () => {
    seed(snapshot(), [locked(1)])

    expect(await deleteComment({ commentId: 11 }, 7, 1)).toBe(
      '该评论正在审核中, 暂时无法删除'
    )
    expectNothingRemoved()
  })

  it('锁下行已不存在', async () => {
    seed(snapshot(), [])

    expect(await deleteComment({ commentId: 11 }, 7, 1)).toBe(
      '未找到对应的评论'
    )
    expectNothingRemoved()
  })
})
