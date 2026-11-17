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
// submit.ts 读审核配置要连 Redis; 这里只用到它的入队
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
import { editComment } from '~/server/content/comment/edit'
import { commentSubject } from '~/server/moderation/subject'
import { MODERATION_SKIP } from '~/server/moderation/submit'

const LOCK =
  '$queryRaw: SELECT id, user_id, patch_id, resource_id, status FROM patch_comment WHERE id = ? FOR UPDATE'

const row = (status: number, overrides: Record<string, unknown> = {}) => ({
  id: 5,
  user_id: 7,
  patch_id: 10,
  resource_id: null,
  status,
  ...overrides
})

const data = { content: 'after', content_html: '<p>after</p>' }
const INTERCEPT = {
  queue: true,
  intercept: true,
  dryRun: false,
  subject: commentSubject('after')
} as const
const DRY_RUN = { ...INTERCEPT, intercept: false, dryRun: true } as const

const edit = (options: Parameters<typeof editComment>[2]) =>
  kunTx('probe', async (ctx) => {
    const { row: edited, skipped } = await editComment(ctx, 5, options)
    return { edited, skipped }
  }) as Promise<{ edited: unknown; skipped: unknown }>

beforeEach(() => {
  rec.reset()
  vi.resetAllMocks()
})

describe('评论编辑', () => {
  it('预筛放行: 锁行后只改内容, 状态不变, 不建任务', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(0)])

    const { edited, skipped } = await edit({
      data,
      moderation: MODERATION_SKIP
    })

    expect(skipped).toBeUndefined()
    expect(edited).toMatchObject({ id: 5 })
    expect(rec.labels()).toEqual([LOCK, 'patch_comment.updateMany'])
    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      { where: { id: 5 }, data: { ...data, status: 0 } }
    ])
    // 公开评论的正文变了: 分页缓存要换; 评论数没变, 详情缓存不动
    expect(commentPageMock.mock.calls).toEqual([[10]])
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  // 管理员代改他人评论: 任务仍归评论作者
  it('预筛拦截: 评论转待审核, 同一事务内按评论作者建任务', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(0)])

    await edit({ data, moderation: INTERCEPT })

    expect(rec.labels()).toEqual([
      LOCK,
      'patch_comment.updateMany',
      // 新任务顶掉同一内容上还在途的旧任务
      'moderation_task.updateMany',
      'moderation_task.create'
    ])
    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      { where: { id: 5 }, data: { ...data, status: 1 } }
    ])
    expect(rec.argsOf('moderation_task.create')).toEqual([
      {
        data: expect.objectContaining({
          content_type: 'comment',
          content_id: 5,
          user_id: 7,
          dry_run: false
        })
      }
    ])
    // 评论离开公开集: 两份缓存都失效; 不发通知
    expect(commentPageMock.mock.calls).toEqual([[10]])
    expect(patchContentMock.mock.calls).toEqual([[[10]]])
    expect(onCommentPublishedMock).not.toHaveBeenCalled()
  })

  it('灰度任务只排队, 不改评论状态', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(0)])

    await edit({ data, moderation: DRY_RUN })

    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      { where: { id: 5 }, data: { ...data, status: 0 } }
    ])
    expect(rec.argsOf('moderation_task.create')).toEqual([
      { data: expect.objectContaining({ content_id: 5, dry_run: true }) }
    ])
    expect(patchContentMock).not.toHaveBeenCalled()
  })

  // 待审评论本就不在公开基线里: 管理员改它的正文不必失效缓存
  it('编辑待审评论 (状态允许时) 状态保持待审, 不失效缓存', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(1)])

    await edit({
      guard: { statusIn: [0, 1] },
      data,
      moderation: MODERATION_SKIP
    })

    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      { where: { id: 5 }, data: { ...data, status: 1 } }
    ])
    expect(commentPageMock).not.toHaveBeenCalled()
  })
})

// 入口事务外读到的快照与写入之间, 评论可能已被管理员隐藏。不在锁下复检的话, 被拦截
// 的编辑会把隐藏的评论写回待审核, 审核一放行就悄悄撤销了管理员的隐藏
describe('评论编辑的守卫在行锁下判定', () => {
  it('锁下已被隐藏: 不写入、不建任务', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(2)])

    const { edited, skipped } = await edit({
      guard: { statusIn: [0], ownerUid: 7 },
      data,
      moderation: INTERCEPT
    })

    expect(edited).toBeUndefined()
    expect(skipped).toEqual({ id: 5, reason: 'status', status: 2 })
    expect(rec.labels()).toEqual([LOCK])
    expect(commentPageMock).not.toHaveBeenCalled()
  })

  it('锁下已转待审: 报出状态供入口选文案', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(1)])

    const { skipped } = await edit({
      guard: { statusIn: [0], ownerUid: 7 },
      data,
      moderation: MODERATION_SKIP
    })

    expect(skipped).toEqual({ id: 5, reason: 'status', status: 1 })
  })

  it('不是作者', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(0)])

    const { skipped } = await edit({
      guard: { statusIn: [0], ownerUid: 8 },
      data,
      moderation: MODERATION_SKIP
    })

    expect(skipped).toEqual({ id: 5, reason: 'owner' })
    expect(rec.labels()).toEqual([LOCK])
  })

  it('行已不存在', async () => {
    rec.onRaw(/FOR UPDATE$/, [])

    const { skipped } = await edit({ data, moderation: MODERATION_SKIP })

    expect(skipped).toEqual({ id: 5, reason: 'gone' })
  })

  // 后台编辑不设守卫: 隐藏的评论也能改, 改完仍是隐藏
  it('不传守卫时隐藏的评论也能改, 状态不变', async () => {
    rec.onRaw(/FOR UPDATE$/, [row(2)])

    const { edited } = await edit({ data, moderation: MODERATION_SKIP })

    expect(edited).toMatchObject({ id: 5 })
    expect(rec.argsOf('patch_comment.updateMany')).toEqual([
      { where: { id: 5 }, data: { ...data, status: 2 } }
    ])
    expect(commentPageMock).not.toHaveBeenCalled()
  })
})
