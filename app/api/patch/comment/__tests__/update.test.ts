import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findCommentMock,
  transactionMock,
  editCommentMock,
  renderMock,
  planTextModerationMock,
  hasPendingModerationMock
} = vi.hoisted(() => ({
  findCommentMock: vi.fn(),
  transactionMock: vi.fn(),
  editCommentMock: vi.fn(),
  renderMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  hasPendingModerationMock: vi.fn()
}))

const transactionClient = {}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findUnique: findCommentMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdownForWrite: renderMock
}))

vi.mock('~/server/moderation/submit', () => ({
  hasPendingModeration: hasPendingModerationMock,
  planTextModeration: planTextModerationMock
}))

// 锁行、行锁下复检守卫、写入、建任务与缓存失效由编辑命令自己的测试覆盖;
// 这里只看入口的预检、给命令的守卫与送审计划, 以及文案映射
vi.mock('~/server/content/comment/edit', () => ({
  editComment: editCommentMock
}))

import { commentSubject } from '~/server/moderation/subject'
import { updateComment } from '~/app/api/patch/comment/update'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'

const stored = { id: 5, user_id: 7, content: 'before', status: 0 }
const input = { commentId: 5, content: 'after', isSpoiler: false }
const SKIP = { queue: false, intercept: false, dryRun: false }
const INTERCEPT = { queue: true, intercept: true, dryRun: false }

const txContext = expect.objectContaining({ tx: transactionClient })

beforeEach(() => {
  vi.resetAllMocks()
  findCommentMock.mockResolvedValue(stored)
  hasPendingModerationMock.mockResolvedValue(false)
  renderMock.mockResolvedValue({ html: '<p>after</p>', version: 1 })
  planTextModerationMock.mockResolvedValue(SKIP)
  editCommentMock.mockResolvedValue({ row: { id: 5 }, skipped: undefined })
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => unknown) =>
      callback(transactionClient)
  )
})

describe('updateComment 送审', () => {
  // 先发正常内容再改成违规即可绕过审核, 所以编辑必须把新旧正文都交给预筛
  it('把编辑前的正文作为 previous 交给预筛, 由预筛判定是否重审', async () => {
    const actor = kunTestActor({ uid: 7, role: 1 })
    await updateComment(input, actor)

    expect(planTextModerationMock).toHaveBeenCalledWith(
      commentSubject('after'),
      { actor, previous: commentSubject('before') }
    )
  })

  it('把预筛的结果原样交给编辑命令', async () => {
    planTextModerationMock.mockResolvedValue(INTERCEPT)

    await updateComment(input, kunTestActor({ uid: 7, role: 1 }))

    expect(editCommentMock.mock.calls[0][2].moderation).toBe(INTERCEPT)
  })

  it('渲染不出来的正文返回错误消息, 不进入预筛、不写库', async () => {
    renderMock.mockResolvedValue(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )

    expect(await updateComment(input, kunTestActor({ uid: 7, role: 1 }))).toBe(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )
    expect(renderMock).toHaveBeenCalledWith('comment', 'after')
    expect(planTextModerationMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('正文与派生 HTML、版本一起交给编辑命令', async () => {
    const result = await updateComment(input, kunTestActor({ uid: 7, role: 1 }))

    expect(editCommentMock).toHaveBeenCalledWith(txContext, 5, {
      guard: { statusIn: [0], ownerUid: 7 },
      data: {
        content: 'after',
        content_html: '<p>after</p>',
        content_html_version: 1,
        is_spoiler: false,
        edit: expect.any(String)
      },
      moderation: SKIP
    })
    expect(result).toEqual({
      contentHtml: '<p>after</p>',
      contentPreview: 'after'
    })
  })
})

describe('updateComment 事务外预检', () => {
  it.each([
    ['评论不存在', null, 7, 1, '未找到该评论'],
    // 隐藏的评论仅后台可管理, 前端与不存在等同 (对管理员也一样)
    ['评论已隐藏', { ...stored, status: 2 }, 9, 3, '未找到该评论'],
    ['不是作者也不是管理员', stored, 8, 1, '您没有权限更改该评论'],
    [
      '作者改自己待审的评论',
      { ...stored, status: 1 },
      7,
      1,
      '您发布的评论正在审核中, 暂时无法修改'
    ]
  ] as const)('%s', async (_name, row, uid, role, message) => {
    findCommentMock.mockResolvedValue(row)

    expect(await updateComment(input, kunTestActor({ uid, role }))).toBe(
      message
    )
    expect(planTextModerationMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('审核中的评论禁止作者再次修改, 不进入预筛', async () => {
    hasPendingModerationMock.mockResolvedValue(true)

    expect(await updateComment(input, kunTestActor({ uid: 7, role: 1 }))).toBe(
      '您发布的评论正在审核中, 暂时无法修改'
    )
    expect(planTextModerationMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })
})

// 预检读的是快照; 同一组条件作为守卫交给编辑命令在行锁下再判一次
describe('updateComment 给编辑命令的守卫', () => {
  it('作者: 只能改自己公开的评论', async () => {
    await updateComment(input, kunTestActor({ uid: 7, role: 1 }))

    expect(editCommentMock.mock.calls[0][2].guard).toEqual({
      statusIn: [0],
      ownerUid: 7
    })
  })

  it('管理员: 可以改他人公开或待审的评论, 隐藏的不行', async () => {
    await updateComment(input, kunTestActor({ uid: 9, role: 3 }))

    expect(editCommentMock.mock.calls[0][2].guard).toEqual({ statusIn: [0, 1] })
  })

  it.each([
    // 快照之后被管理员隐藏: 这次编辑不会把它写回待审核
    [{ id: 5, reason: 'status', status: 2 }, '未找到该评论'],
    [
      { id: 5, reason: 'status', status: 1 },
      '您发布的评论正在审核中, 暂时无法修改'
    ],
    [{ id: 5, reason: 'gone' }, '未找到该评论'],
    [{ id: 5, reason: 'owner' }, '您没有权限更改该评论']
  ])('行锁下守卫未通过 %o → %s', async (skipped, message) => {
    editCommentMock.mockResolvedValue({ row: undefined, skipped })

    expect(await updateComment(input, kunTestActor({ uid: 7, role: 1 }))).toBe(
      message
    )
  })
})
