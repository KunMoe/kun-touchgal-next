import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_LOG_CONTENT_LIMIT } from '~/constants/admin'

const {
  findCommentMock,
  findAdminMock,
  transactionMock,
  createLogMock,
  renderMock,
  planTextModerationMock,
  editCommentMock
} = vi.hoisted(() => ({
  findCommentMock: vi.fn(),
  findAdminMock: vi.fn(),
  transactionMock: vi.fn(),
  createLogMock: vi.fn(),
  renderMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  editCommentMock: vi.fn()
}))

const transactionClient = {
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findUnique: findCommentMock },
    user: { findUnique: findAdminMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdownForWrite: renderMock
}))

vi.mock('~/server/moderation/submit', () => ({
  planTextModeration: planTextModerationMock
}))

// 锁行、写入与缓存失效由编辑命令自己的测试覆盖; 这里只看后台入口怎么用它
vi.mock('~/server/content/comment/edit', () => ({
  editComment: editCommentMock
}))

import { commentSubject } from '~/server/moderation/subject'
import { updateComment } from '~/app/api/admin/comment/update'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'

const created = new Date('2026-01-01T00:00:00.000Z')
// content 顶到列上限, content_html 远超 admin_log.content 的 VarChar(10007)
const longContent = '评'.repeat(10007)
const longContentHtml = `<p>${'评'.repeat(60000)}</p>`
const SKIP = { queue: false, intercept: false, dryRun: false }

beforeEach(() => {
  vi.clearAllMocks()
  findCommentMock.mockResolvedValue({
    id: 1,
    content: longContent,
    content_html: longContentHtml,
    content_html_version: 3,
    edit: '',
    status: 0,
    user_id: 101,
    patch_id: 10,
    parent_id: null,
    created,
    updated: created
  })
  findAdminMock.mockResolvedValue({ id: 99, name: 'admin' })
  renderMock.mockResolvedValue({ html: '<p>new</p>', version: 3 })
  planTextModerationMock.mockResolvedValue(SKIP)
  editCommentMock.mockResolvedValue({ row: { id: 1 }, skipped: undefined })
  createLogMock.mockResolvedValue({})
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('updateComment', () => {
  it('logs a bounded summary instead of the full row snapshot', async () => {
    await expect(
      updateComment(
        { commentId: 1, content: 'new content', isSpoiler: false },
        kunTestActor({ uid: 99, role: 4 })
      )
    ).resolves.toEqual({})

    // 后台编辑不设守卫: 隐藏、待审的评论都能改
    expect(editCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({ tx: transactionClient }),
      1,
      {
        data: {
          content: 'new content',
          content_html: '<p>new</p>',
          content_html_version: 3,
          edit: expect.any(String)
        },
        moderation: SKIP
      }
    )

    expect(createLogMock).toHaveBeenCalledTimes(1)
    const logContent = createLogMock.mock.calls[0][0].data.content as string
    expect(logContent.length).toBeLessThanOrEqual(ADMIN_LOG_CONTENT_LIMIT)
    expect(logContent).not.toContain('content_html')
    expect(logContent).toContain(`"contentPreview":"${'评'.repeat(100)}"`)
  })

  // 送审豁免只看操作者的真实角色 (超级管理员豁免), 后台入口不另开口子
  it.each([4, 3] as const)(
    '以操作者的真实角色与编辑前的正文交给预筛 (role %i)',
    async (role) => {
      const actor = kunTestActor({ uid: 99, role })
      await updateComment(
        { commentId: 1, content: 'new content', isSpoiler: false },
        actor
      )

      expect(planTextModerationMock).toHaveBeenCalledWith(
        commentSubject('new content'),
        { actor, previous: commentSubject(longContent) }
      )
      // 交下去的就是调用方给的操作者 (同一对象), 不是入口按固定角色另造的
      expect(planTextModerationMock.mock.calls[0][1].actor).toBe(actor)
    }
  )

  it('评论在行锁下已不存在时报未找到, 不记日志', async () => {
    editCommentMock.mockResolvedValue({
      row: undefined,
      skipped: { id: 1, reason: 'gone' }
    })

    await expect(
      updateComment(
        { commentId: 1, content: 'new content', isSpoiler: false },
        kunTestActor({ uid: 99, role: 4 })
      )
    ).resolves.toBe('未找到对应的评论')
    expect(createLogMock).not.toHaveBeenCalled()
  })

  it('渲染不出来的正文返回错误消息, 不写库、不记日志', async () => {
    renderMock.mockResolvedValue(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )

    await expect(
      updateComment(
        { commentId: 1, content: 'deep', isSpoiler: false },
        kunTestActor({ uid: 99, role: 4 })
      )
    ).resolves.toBe('评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交')

    expect(transactionMock).not.toHaveBeenCalled()
    expect(editCommentMock).not.toHaveBeenCalled()
  })
})
