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
vi.mock('~/server/content/comment/publish', () => ({
  onCommentPublished: onCommentPublishedMock
}))

import { updateCommentShadowBan } from '~/app/api/admin/comment/shadow-ban/shadowBan'

const comment = (status: number) => ({
  id: 5,
  status,
  patch_id: 10,
  user: { name: 'user' }
})

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
  contentCacheMock.mockResolvedValue(undefined)
  rec.on('user.findUnique', { id: 99, name: 'admin' })
  rec.on('patch_comment.findUnique', comment(0))
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
    rec.on('patch_comment.findUnique', comment(2))

    expect(await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)).toBe(
      '该评论已处于隐藏状态'
    )
    expect(rec.attempts).toHaveLength(0)
    expect(commentCacheMock).not.toHaveBeenCalled()
  })
})

describe('updateCommentShadowBan 隐藏', () => {
  it('作废在途审核任务 (保留 dry_run)、写 status、记审计, 提交后失效两份缓存', async () => {
    const result = await updateCommentShadowBan({ commentId: 5, status: 2 }, 99)

    expect(result).toEqual({})
    expect(rec.attempts).toHaveLength(1)
    expect(rec.attempts[0].committed).toBe(true)
    expect(rec.labels()).toEqual([
      'moderation_task.deleteMany',
      'patch_comment.update',
      'admin_log.create'
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      {
        where: {
          content_type: 'comment',
          content_id: 5,
          status: { in: ['pending', 'manual'] },
          dry_run: false
        }
      }
    ])
    expect(rec.argsOf('patch_comment.update')).toEqual([
      { where: { id: 5 }, data: { status: 2 } }
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
    expect(commentCacheMock).toHaveBeenCalledWith(10)
    expect(contentCacheMock).toHaveBeenCalledWith(10)
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
    rec.on('patch_comment.findUnique', comment(from))

    const result = await updateCommentShadowBan({ commentId: 5, status: 0 }, 99)

    expect(result).toEqual({})
    expect(rec.argsOf('patch_comment.update')).toEqual([
      { where: { id: 5 }, data: { status: 0 } }
    ])
    expect(onCommentPublishedMock).toHaveBeenCalledWith(5)
    const published = onCommentPublishedMock.mock.invocationCallOrder[0]
    expect(commentCacheMock.mock.invocationCallOrder[0]).toBeLessThan(published)
    expect(contentCacheMock.mock.invocationCallOrder[0]).toBeLessThan(published)
  })
})
