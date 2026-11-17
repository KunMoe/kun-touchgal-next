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

import { deleteComment } from '~/app/api/admin/comment/delete'

const row = (id: number, patchId: number, status = 0) => ({
  id,
  user_id: 7,
  patch_id: patchId,
  parent_id: null,
  resource_id: null,
  status,
  content: '评论正文'
})

// snapshot 是事务外读到的行; lockedRows 是行锁下重读到的; subtree 含级联带走的回复
const seed = (
  snapshot: ReturnType<typeof row>[],
  lockedRows: ReturnType<typeof row>[] = snapshot,
  subtree: ReturnType<typeof row>[] = lockedRows
) => {
  rec.on(
    'patch_comment.findMany',
    (args: { where: { id: { in: number[] } }; select?: unknown }) =>
      // 带 select 的是 cleanupCommentNotifications 在事务里按行反推收件人
      args.select
        ? subtree.map((item) => ({
            id: item.id,
            user_id: item.user_id,
            parent_id: null,
            resource_id: null,
            parent: null,
            resource: null,
            patch: { unique_id: `patch-${item.patch_id}` }
          }))
        : snapshot
  )
  rec.onRaw(/FOR UPDATE$/, lockedRows)
  rec.onRaw(/^WITH RECURSIVE subtree/, subtree)
}

const logContent = () =>
  (rec.argsOf('admin_log.create')[0] as { data: { content: string } }).data
    .content

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  rec.on('user.findUnique', { id: 99, name: 'admin' })
})

describe('adminDeleteComment', () => {
  it('返回连同回复子树在内实际删除的全部 id, 审计日志写在同一事务里', async () => {
    seed([row(11, 10)], [row(11, 10)], [row(11, 10), row(12, 10)])

    const result = await deleteComment({ commentIds: [11] }, 99)

    expect(result).toEqual({ deletedIds: [11, 12] })
    expect(rec.attempts[0].committed).toBe(true)
    // 行删除后深链无从重建, 通知清理必须在删除之前。开头四条是取锁: 根、子树 (第二遍
    // 确认没有新回复)、patch 行
    expect(
      rec
        .labels()
        .map((label) => label.replace(/^(\$queryRaw|\$executeRaw): .*$/, '$1'))
    ).toEqual([
      '$queryRaw',
      '$queryRaw',
      '$queryRaw',
      '$executeRaw',
      'patch_comment.findMany',
      'user_message.deleteMany',
      'user_message.deleteMany',
      'patch_comment.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_report.deleteMany',
      'admin_log.create'
    ])
    expect(logContent()).toContain('管理员 admin 删除了一条评论')
  })

  it('跨补丁批量删除: 一次清理覆盖全部子树, 各补丁的缓存都失效', async () => {
    seed(
      [row(11, 10), row(21, 20)],
      [row(11, 10), row(21, 20)],
      [row(11, 10), row(12, 10), row(21, 20)]
    )

    const result = await deleteComment({ commentIds: [11, 21] }, 99)

    expect(result).toEqual({ deletedIds: [11, 12, 21] })
    expect(rec.argsOf('patch_comment.deleteMany')).toEqual([
      { where: { id: { in: [11, 21] } } }
    ])
    expect(rec.labels().filter((l) => l === 'patch_comment.findMany')).toEqual([
      'patch_comment.findMany'
    ])
    expect(commentPageMock.mock.calls).toEqual([[10], [20]])
    expect(patchContentMock.mock.calls).toEqual([[[10, 20]]])
    expect(logContent()).toContain('批量删除了 2 条评论')
  })

  // 后台删除不复检 status: 隐藏、待审的评论都能删
  it('隐藏与待审的评论照删, 不在公开基线里的行不触发缓存失效', async () => {
    seed([row(11, 10, 2), row(12, 10, 1)])

    const result = await deleteComment({ commentIds: [11, 12] }, 99)

    expect(result).toEqual({ deletedIds: [11, 12] })
    // 两条都作为根被删: 入口若传了状态守卫, 隐藏的 11 会被跳过
    expect(rec.argsOf('patch_comment.deleteMany')).toEqual([
      { where: { id: { in: [11, 12] } } }
    ])
    expect(commentPageMock).not.toHaveBeenCalled()
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  // 读取与加锁之间有的评论已被别人删掉: 审计只记这次真正删掉的
  it('审计日志只记锁下实际删掉的评论', async () => {
    seed([row(11, 10), row(21, 20)], [row(21, 20)])

    const result = await deleteComment({ commentIds: [11, 21] }, 99)

    expect(result).toEqual({ deletedIds: [21] })
    expect(logContent()).toContain('删除了一条评论')
    expect(logContent()).toContain('"id":21')
    expect(logContent()).not.toContain('"id":11')
  })

  it('锁下一条都不剩时报未找到, 不写审计', async () => {
    seed([row(11, 10)], [])

    expect(await deleteComment({ commentIds: [11] }, 99)).toBe(
      '未找到对应的评论'
    )
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(rec.labels()).not.toContain('admin_log.create')
  })

  it('事务外一条都没读到时不开事务', async () => {
    seed([])

    expect(await deleteComment({ commentIds: [11] }, 99)).toBe(
      '未找到对应的评论'
    )
    expect(rec.attempts).toHaveLength(0)
  })

  it('管理员不存在', async () => {
    seed([row(11, 10)])
    rec.on('user.findUnique', null)

    expect(await deleteComment({ commentIds: [11] }, 99)).toBe('未找到该管理员')
    expect(rec.attempts).toHaveLength(0)
  })
})
