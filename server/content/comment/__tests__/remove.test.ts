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

import { kunTx } from '~/server/db/tx'
import {
  executeCommentRemoval,
  planCommentRemoval
} from '~/server/content/comment/remove'
import type {
  CommentRemovalGuard,
  CommentRemovalPlan
} from '~/server/content/comment/remove'

const LOCK =
  '$queryRaw: SELECT id, user_id, patch_id, resource_id, status FROM patch_comment WHERE id = ANY(?::int[]) ORDER BY id FOR UPDATE'
const SUBTREE =
  '$queryRaw: WITH RECURSIVE subtree AS ( SELECT id FROM patch_comment WHERE id = ANY(?::int[]) UNION SELECT pc.id FROM patch_comment pc INNER JOIN subtree s ON pc.parent_id = s.id ) SELECT pc.id, pc.patch_id, pc.resource_id, pc.status FROM patch_comment pc WHERE pc.id IN (SELECT id FROM subtree) ORDER BY pc.id FOR UPDATE OF pc'
const PATCH_LOCK =
  '$executeRaw: SELECT id FROM patch WHERE id = ANY(?::int[]) ORDER BY id FOR NO KEY UPDATE'

const row = (
  id: number,
  status = 0,
  overrides: Record<string, unknown> = {}
) => ({ id, user_id: 7, patch_id: 10, resource_id: null, status, ...overrides })

// 根的锁查询回 locked, 子树的「收集并加锁」回 subtree (缺省等于 locked)
const seed = (
  locked: ReturnType<typeof row>[],
  subtree: ReturnType<typeof row>[] = locked
) => {
  rec.onRaw(/FOR UPDATE$/, locked)
  rec.onRaw(/^WITH RECURSIVE subtree/, subtree)
  // cleanupCommentNotifications 按行反推收件人
  rec.on('patch_comment.findMany', () =>
    subtree.map((item) => ({
      id: item.id,
      user_id: item.user_id,
      parent_id: null,
      resource_id: item.resource_id,
      parent: null,
      resource: null,
      patch: { unique_id: 'patch-10' }
    }))
  )
}

const remove = (
  ids: number[],
  guard?: CommentRemovalGuard,
  orphanReports: 'inline' | 'caller' = 'inline'
) =>
  kunTx('probe', async (ctx) => {
    const plan = await planCommentRemoval(ctx, ids, guard)
    const result = await executeCommentRemoval(ctx, plan, { orphanReports })
    return { plan, ...result }
  }) as Promise<{ plan: CommentRemovalPlan; deletedIds: number[] }>

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('评论删除的语句顺序', () => {
  it('锁根行 → 锁子树 (再收集一遍确认没有新行) → 锁 patch 行 → 清通知 → 删根 → 清任务与申诉 → 清孤儿举报', async () => {
    seed([row(11)], [row(11), row(12)])

    const { deletedIds } = await remove([11])

    expect(deletedIds).toEqual([11, 12])
    expect(rec.attempts[0].committed).toBe(true)
    expect(rec.labels()).toEqual([
      LOCK,
      SUBTREE,
      SUBTREE,
      PATCH_LOCK,
      'patch_comment.findMany',
      'user_message.deleteMany',
      'user_message.deleteMany',
      'patch_comment.deleteMany',
      'moderation_task.deleteMany',
      'moderation_appeal.deleteMany',
      'patch_report.deleteMany'
    ])
  })

  it('只删根 (回复随外键级联), 通知、任务、申诉按整棵子树清', async () => {
    seed([row(11)], [row(11), row(12), row(13)])

    await remove([11])

    expect(rec.argsOf('patch_comment.deleteMany')).toEqual([
      { where: { id: { in: [11] } } }
    ])
    expect(rec.argsOf('patch_comment.findMany')).toEqual([
      expect.objectContaining({ where: { id: { in: [11, 12, 13] } } })
    ])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      {
        where: {
          content_type: 'comment',
          content_id: { in: [11, 12, 13] },
          status: { in: ['pending', 'manual'] }
        }
      }
    ])
    expect(rec.argsOf('moderation_appeal.deleteMany')).toEqual([
      {
        where: {
          content_type: 'comment',
          content_id: { in: [11, 12, 13] },
          status: 'pending'
        }
      }
    ])
    // 孤儿举报: 目标已被级联置空且仍未处理
    expect(rec.argsOf('patch_report.deleteMany')).toEqual([
      { where: { target_type: 'comment', status: 0, comment_id: null } }
    ])
  })

  it('批量删除按 id 升序锁根行, 一次清理覆盖全部子树', async () => {
    seed([row(11), row(21, 0, { patch_id: 20 })])

    const { deletedIds } = await remove([21, 11])

    expect(rec.argsOf(LOCK)).toEqual([[[21, 11]]])
    expect(rec.argsOf(SUBTREE)).toEqual([[[11, 21]]])
    expect(deletedIds).toEqual([11, 21])
    expect(rec.argsOf('patch_comment.deleteMany')).toEqual([
      { where: { id: { in: [11, 21] } } }
    ])
  })

  // 没锁住的回复下面还能插进新回复, 随后被级联带走, 它的任务与通知却不在清理集合里
  it('子树收集到稳定为止: 等锁期间才提交的新回复, 下一轮收集并锁住', async () => {
    const rounds = [
      [row(11), row(12)],
      [row(11), row(12), row(13)],
      [row(11), row(12), row(13)]
    ]
    seed([row(11)], [row(11), row(12), row(13)])
    rec.onRaw(/^WITH RECURSIVE subtree/, () => rounds.shift())

    const { deletedIds } = await remove([11])

    expect(rec.argsOf(SUBTREE)).toEqual([[[11]], [[11]], [[11]]])
    expect(deletedIds).toEqual([11, 12, 13])
    expect(rec.argsOf('moderation_task.deleteMany')).toEqual([
      {
        where: {
          content_type: 'comment',
          content_id: { in: [11, 12, 13] },
          status: { in: ['pending', 'manual'] }
        }
      }
    ])
  })

  it('没有回复的根只收集一遍: 返回的行都已在根的锁里', async () => {
    seed([row(11)])

    await remove([11])

    expect(rec.argsOf(SUBTREE)).toEqual([[[11]]])
  })

  // 计数触发器只在公开的补丁级评论被删时改 patch 行; 评论行全部锁完之后再锁 patch 行
  it('patch 行只锁公开的补丁级评论所属的补丁, 排在全部评论行之后、第一条清理语句之前', async () => {
    seed(
      [row(11, 0, { patch_id: 30 })],
      [
        row(11, 0, { patch_id: 30 }),
        row(12, 0, { patch_id: 30 }),
        row(13, 2, { patch_id: 20 }),
        row(14, 0, { patch_id: 10, resource_id: 5 })
      ]
    )

    await remove([11])

    expect(rec.argsOf(PATCH_LOCK)).toEqual([[[30]]])
    const labels = rec.labels()
    expect(labels.indexOf(PATCH_LOCK)).toBeGreaterThan(
      labels.lastIndexOf(SUBTREE)
    )
    expect(labels.indexOf(PATCH_LOCK)).toBeLessThan(
      labels.indexOf('patch_comment.findMany')
    )
  })

  it('被删的行里没有公开的补丁级评论时不锁 patch 行', async () => {
    seed([row(11, 2), row(12, 0, { resource_id: 5 })])

    await remove([11, 12])

    expect(rec.labels()).not.toContain(PATCH_LOCK)
  })

  // 举报处理要先把本次收集到的举报转为历史, 再由它自己清剩下的孤儿
  it("orphanReports 为 'caller' 时不清孤儿举报", async () => {
    seed([row(11)])

    await remove([11], undefined, 'caller')

    expect(rec.labels()).not.toContain('patch_report.deleteMany')
    expect(rec.labels().at(-1)).toBe('moderation_appeal.deleteMany')
  })
})

describe('守卫在行锁下判定', () => {
  it.each([
    ['隐藏', 2],
    ['待审', 1]
  ])(
    '状态不在 statusIn 里 (%s) 时跳过: 不收集子树、不清理、不删除',
    async (_label, status) => {
      seed([row(11, status)])

      const { plan, deletedIds } = await remove([11], { statusIn: [0] })

      expect(plan.roots).toEqual([])
      expect(plan.skipped).toEqual([{ id: 11, reason: 'status', status }])
      expect(deletedIds).toEqual([])
      // 内容保留时, 它的通知、审核任务、申诉、举报都要留着
      expect(rec.labels()).toEqual([LOCK])
      expect(commentPageMock).not.toHaveBeenCalled()
    }
  )

  it('行已不存在时报 gone', async () => {
    seed([])

    const { plan } = await remove([11], { statusIn: [0] })

    expect(plan.skipped).toEqual([{ id: 11, reason: 'gone' }])
    expect(rec.labels()).toEqual([LOCK])
  })

  it('ownerUid 不是作者时报 owner', async () => {
    seed([row(11)])

    const { plan } = await remove([11], { statusIn: [0], ownerUid: 8 })

    expect(plan.skipped).toEqual([{ id: 11, reason: 'owner' }])
    expect(rec.labels()).toEqual([LOCK])
  })

  it('作者本人、状态符合时放行', async () => {
    seed([row(11)])

    const { plan } = await remove([11], { statusIn: [0], ownerUid: 7 })

    expect(plan.skipped).toEqual([])
    expect(plan.roots.map((item) => item.id)).toEqual([11])
  })

  // 后台删除不设守卫: 隐藏、待审的评论都能删
  it('不传守卫时任何状态都删', async () => {
    seed([row(11, 2), row(12, 1)])

    const { plan, deletedIds } = await remove([11, 12])

    expect(plan.skipped).toEqual([])
    expect(deletedIds).toEqual([11, 12])
  })

  it('一批里通过与跳过并存时只删通过的', async () => {
    seed([row(11), row(12, 2)], [row(11)])

    const { plan, deletedIds } = await remove([11, 12, 13], {
      statusIn: [0]
    })

    expect(plan.skipped).toEqual([
      { id: 12, reason: 'status', status: 2 },
      { id: 13, reason: 'gone' }
    ])
    expect(deletedIds).toEqual([11])
    expect(rec.argsOf(SUBTREE)).toEqual([[[11]]])
  })
})

describe('提交后的缓存失效由被删行的状态推导', () => {
  it('删除公开评论: 评论分页缓存与补丁详情缓存都失效', async () => {
    seed([row(11)])

    await remove([11])

    expect(commentPageMock.mock.calls).toEqual([[10]])
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
  })

  it('资源评论不计入补丁的评论数, 只失效分页缓存', async () => {
    seed([row(11, 0, { resource_id: 5 })])

    await remove([11])

    expect(commentPageMock.mock.calls).toEqual([[10]])
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  // 回复行与根一样在行锁下读到, 状态就是删除瞬间的状态
  it('隐藏的根带着公开回复: 两份缓存都失效', async () => {
    seed([row(11, 2)], [row(11, 2), row(12, 0)])

    await remove([11], { statusIn: [2] })

    expect(commentPageMock.mock.calls).toEqual([[10]])
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
  })

  it('隐藏的根带着待审回复: 不失效任何缓存', async () => {
    seed([row(11, 2)], [row(11, 2), row(12, 1)])

    await remove([11], { statusIn: [2] })

    expect(commentPageMock).not.toHaveBeenCalled()
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('没有回复的隐藏或待审评论被删: 不失效任何缓存', async () => {
    seed([row(11, 2), row(12, 1)])

    await remove([11, 12])

    expect(commentPageMock).not.toHaveBeenCalled()
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  it('事务回滚时不失效缓存', async () => {
    seed([row(11)])

    const result = await kunTx('probe', async (ctx) => {
      const plan = await planCommentRemoval(ctx, [11])
      await executeCommentRemoval(ctx, plan, { orphanReports: 'inline' })
      return ctx.fail('后续步骤失败')
    })

    expect(result).toBe('后续步骤失败')
    expect(rec.attempts[0].rolledBack).toBe(true)
    expect(commentPageMock).not.toHaveBeenCalled()
  })
})
