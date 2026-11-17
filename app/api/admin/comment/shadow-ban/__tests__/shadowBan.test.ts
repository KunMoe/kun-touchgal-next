import { beforeEach, describe, expect, it, vi } from 'vitest'

const rec = await vi.hoisted(async () =>
  (
    await import('~/server/db/__tests__/recordingTransaction')
  ).recordingTransaction()
)
const { commentCacheMock, contentCacheMock, onCommentPublishedMock } =
  vi.hoisted(() => ({
    commentCacheMock: vi.fn(),
    contentCacheMock: vi.fn(),
    onCommentPublishedMock: vi.fn()
  }))

vi.mock('~/prisma/index', () => rec.module)
// submit.ts 读审核配置要连 Redis; 这里只用到它的 deletePendingModerationTasks
vi.mock('~/server/moderation/config', () => ({ getModerationConfig: vi.fn() }))
vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: commentCacheMock
}))
vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCacheByPatchId: contentCacheMock
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

import { updateCommentShadowBan } from '~/app/api/admin/comment/shadow-ban/shadowBan'

const LOCK =
  '$queryRaw: SELECT id, patch_id, resource_id, status FROM patch_comment WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE'

// snapshotStatus 是事务外预检读到的状态; lockedStatus 是行锁下读到的 (null 即已删除)
const seed = (
  snapshotStatus: number,
  lockedStatus: number | null = snapshotStatus
) => {
  rec.on('patch_comment.findUnique', (args: { select: { status?: boolean } }) =>
    // 带 status 的是事务外预检; 不带的是迁移落空后查行是否还在
    args.select.status
      ? { id: 5, status: snapshotStatus, user: { name: 'user' } }
      : lockedStatus === null
        ? null
        : { id: 5 }
  )
  rec.onRaw(
    /FOR UPDATE$/,
    lockedStatus === null
      ? []
      : [{ id: 5, patch_id: 10, resource_id: null, status: lockedStatus }]
  )
}

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  rec.on('user.findUnique', { id: 99, name: 'admin' })
  seed(0)
})

describe('updateCommentShadowBan 拒绝分支', () => {
  it('管理员不存在', async () => {
    rec.on('user.findUnique', null)

    expect(await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)).toBe(
      '未找到该管理员'
    )
    expect(rec.attempts).toHaveLength(0)
  })

  it('评论不存在', async () => {
    rec.on('patch_comment.findUnique', null)

    expect(await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)).toBe(
      '未找到该评论'
    )
    expect(rec.attempts).toHaveLength(0)
  })

  it('已处于目标状态', async () => {
    seed(2)

    expect(await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)).toBe(
      '该评论已处于隐藏状态'
    )
    expect(rec.attempts).toHaveLength(0)
    expect(commentCacheMock).not.toHaveBeenCalled()
  })
})

// 预检读的是快照; 同样的判断在行锁下再做一次
describe('updateCommentShadowBan 行锁下复检', () => {
  it('快照正常, 锁下已被别人隐藏: 不写状态、不作废任务、不记审计', async () => {
    seed(0, 2)

    expect(await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)).toBe(
      '该评论已处于隐藏状态'
    )
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(rec.labels()).toEqual([LOCK, 'patch_comment.findUnique'])
    expect(commentCacheMock).not.toHaveBeenCalled()
  })

  it('锁下评论已被删除', async () => {
    seed(0, null)

    expect(await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)).toBe(
      '未找到该评论'
    )
    expect(rec.labels()).not.toContain('admin_log.create')
  })
})

describe('updateCommentShadowBan 隐藏', () => {
  // 锁序: 评论行 → 审核任务, 与审核裁决、删除一致
  it('先锁评论行, 写 status, 再作废在途审核任务 (保留 dry_run), 记审计, 提交后失效两份缓存', async () => {
    const result = await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)

    expect(result).toEqual({})
    expect(rec.attempts).toHaveLength(1)
    expect(rec.attempts[0].committed).toBe(true)
    expect(rec.labels()).toEqual([
      LOCK,
      'patch_comment.updateMany',
      'moderation_task.deleteMany',
      'admin_log.create'
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
    // 待审核的评论也可以隐藏
    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      {
        where: { id: { in: [5] }, status: { in: [0, 1] } },
        data: { status: 2 }
      }
    ])
    expect(rec.argsOf('admin_log.create')).toEqual([
      {
        data: {
          type: 'update',
          user_id: 99,
          content:
            '管理员 admin 将用户 user 的评论 (ID: 5) 状态由 正常 修改为 隐藏'
        }
      }
    ])
    expect(commentCacheMock.mock.calls).toEqual([[10]])
    expect(contentCacheMock.mock.calls).toEqual([[[10]]])
  })

  // 审计里的「由 X 修改为」取行锁下的状态, 不取快照
  it('审计记行锁下读到的原状态', async () => {
    seed(0, 1)

    await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)

    expect(
      (rec.argsOf('admin_log.create')[0] as { data: { content: string } }).data
        .content
    ).toContain('状态由 待审核 修改为 隐藏')
    // 待审核的评论本就不在公开基线里: 隐藏它不必失效缓存
    expect(commentCacheMock).not.toHaveBeenCalled()
  })

  it('隐藏不发通知', async () => {
    await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)

    expect(onCommentPublishedMock).not.toHaveBeenCalled()
  })
})

// 评论可能从未公开过: 创建即被审核拦截, 随后被拒 (→隐藏) 或一直待审。那时没发出的
// 回复 / 资源上传者 / 提及通知, 要在管理员把它恢复为正常时补上
describe('updateCommentShadowBan 恢复为正常', () => {
  it.each([
    ['隐藏', 2],
    ['待审核', 1]
  ])('从%s恢复后补发通知, 排在缓存失效之后', async (_label, from) => {
    seed(from)

    const result = await updateCommentShadowBan({ commentId: 5, status: 0 }, 99)

    expect(result).toEqual({})
    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      {
        where: { id: { in: [5] }, status: { in: [1, 2] } },
        data: { status: 0 }
      }
    ])
    expect(onCommentPublishedMock).toHaveBeenCalledWith(5)
    const published = onCommentPublishedMock.mock.invocationCallOrder[0]
    expect(commentCacheMock.mock.invocationCallOrder[0]).toBeLessThan(published)
    expect(contentCacheMock.mock.invocationCallOrder[0]).toBeLessThan(published)
  })
})
