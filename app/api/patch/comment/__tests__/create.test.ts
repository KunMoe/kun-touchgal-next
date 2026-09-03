import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createCommentMock,
  transactionMock,
  markdownToHtmlCommentMock,
  preScreenTextMock,
  createModerationTaskMock,
  createDedupMessageMock,
  createLinkDedupMessageMock,
  createMentionMessageMock,
  invalidateContentMock,
  invalidateUnreadMock,
  parentFindFirstMock,
  resourceFindFirstMock
} = vi.hoisted(() => ({
  createCommentMock: vi.fn(),
  transactionMock: vi.fn(),
  markdownToHtmlCommentMock: vi.fn(),
  preScreenTextMock: vi.fn(),
  createModerationTaskMock: vi.fn(),
  createDedupMessageMock: vi.fn(),
  createLinkDedupMessageMock: vi.fn(),
  createMentionMessageMock: vi.fn(),
  invalidateContentMock: vi.fn(async () => undefined),
  invalidateUnreadMock: vi.fn(async () => undefined),
  parentFindFirstMock: vi.fn(),
  resourceFindFirstMock: vi.fn()
}))

const transactionClient = {
  patch_comment: {
    create: createCommentMock
  }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_comment: { findFirst: parentFindFirstMock },
    patch_resource: { findFirst: resourceFindFirstMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/message', () => ({
  createDedupMessage: createDedupMessageMock,
  createLinkDedupMessage: createLinkDedupMessageMock
}))

vi.mock('~/app/api/utils/createMentionMessage', () => ({
  createMentionMessage: createMentionMessageMock
}))

vi.mock('~/app/api/utils/render/markdownToHtmlComment', () => ({
  COMMENT_HTML_VERSION: 1,
  markdownToHtmlComment: markdownToHtmlCommentMock
}))

vi.mock('~/server/moderation/submit', () => ({
  createModerationTask: createModerationTaskMock,
  preScreenText: preScreenTextMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

import { createPatchComment } from '~/app/api/patch/comment/create'

const created = new Date('2026-01-01T00:00:00.000Z')
const comment = {
  id: 11,
  content: 'comment',
  is_spoiler: false,
  status: 0,
  user_id: 7,
  patch_id: 10,
  parent_id: null,
  created,
  updated: created,
  patch: { name: 'Patch', unique_id: 'patch-10' },
  user: { name: 'user' }
}
const input = {
  patchId: 10,
  parentId: null,
  content: 'comment',
  isSpoiler: false
}

beforeEach(() => {
  vi.clearAllMocks()
  createCommentMock.mockResolvedValue(comment)
  markdownToHtmlCommentMock.mockResolvedValue('<p>comment</p>')
  preScreenTextMock.mockResolvedValue({
    queue: false,
    intercept: false,
    dryRun: false
  })
  createModerationTaskMock.mockResolvedValue(undefined)
  createMentionMessageMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('createPatchComment', () => {
  it('starts moderation pre-screening before Markdown rendering completes', async () => {
    let resolveRender: ((html: string) => void) | undefined
    markdownToHtmlCommentMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRender = resolve
        })
    )

    const creation = createPatchComment(input, 7, 2)

    expect(preScreenTextMock).toHaveBeenCalledWith('comment', 2)
    expect(transactionMock).not.toHaveBeenCalled()

    resolveRender?.('<p>comment</p>')
    const result = await creation

    expect(createCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content_html: '<p>comment</p>',
          content_html_version: 1,
          status: 0
        })
      })
    )
    expect(result).toEqual(
      expect.objectContaining({ content: '<p>comment</p>', status: 0 })
    )
  })

  it('preserves the stored fallback when initial Markdown rendering fails', async () => {
    markdownToHtmlCommentMock
      .mockRejectedValueOnce(new Error('render failed'))
      .mockResolvedValueOnce('<p>retry</p>')

    const result = await createPatchComment(input, 7, 2)

    expect(createCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content_html: '',
          content_html_version: 0,
          status: 0
        })
      })
    )
    expect(result).toEqual(
      expect.objectContaining({ content: '<p>retry</p>', status: 0 })
    )
  })

  it('评论创建后按 unique_id 失效补丁详情缓存 (M-05)', async () => {
    await createPatchComment(input, 7, 2)

    expect(invalidateContentMock).toHaveBeenCalledWith('patch-10')
  })

  it('创建评论时把调用者角色透传给审核预筛', async () => {
    await createPatchComment(input, 7, 3)

    expect(preScreenTextMock).toHaveBeenCalledWith('comment', 3)
  })

  it('回复通知写入后失效父评论作者的未读缓存', async () => {
    parentFindFirstMock.mockResolvedValue({
      user_id: 9,
      content: 'parent',
      status: 0,
      resource_id: null
    })

    await createPatchComment({ ...input, parentId: 6 }, 7, 2)

    expect(createDedupMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ recipient_id: 9 })
    )
    expect(invalidateUnreadMock).toHaveBeenCalledWith(9)
    expect(createDedupMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateUnreadMock.mock.invocationCallOrder[0]
    )
  })

  it('回复自己的评论不发通知也不失效未读缓存', async () => {
    parentFindFirstMock.mockResolvedValue({
      user_id: 7,
      content: 'parent',
      status: 0,
      resource_id: null
    })

    await createPatchComment({ ...input, parentId: 6 }, 7, 2)

    expect(createDedupMessageMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('被审核拦截时不发通知也不失效未读缓存', async () => {
    parentFindFirstMock.mockResolvedValue({
      user_id: 9,
      content: 'parent',
      status: 0,
      resource_id: null
    })
    preScreenTextMock.mockResolvedValue({
      queue: true,
      intercept: true,
      dryRun: false
    })

    await createPatchComment({ ...input, parentId: 6 }, 7, 2)

    // 拦截时通知由 apply.ts 在审核通过后补发, 此处不写消息、不失效
    expect(createDedupMessageMock).not.toHaveBeenCalled()
    expect(createMentionMessageMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })
})

describe('createPatchComment 资源评论', () => {
  const resourceInput = { ...input, resourceId: 5 }

  beforeEach(() => {
    resourceFindFirstMock.mockResolvedValue({ user_id: 3 })
    createCommentMock.mockResolvedValue({ ...comment, resource_id: 5 })
  })

  it('顶层资源评论落库 resource_id 并通知资源上传者', async () => {
    await createPatchComment(resourceInput, 7, 2)

    expect(resourceFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 5, patch_id: 10 })
      })
    )
    expect(createCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resource_id: 5 })
      })
    )
    // 上传者通知走 link 维度去重 (评论编辑重审通过后 content 会变)
    expect(createLinkDedupMessageMock).toHaveBeenCalledWith({
      type: 'comment',
      content: '评论了您发布的资源：comment',
      sender_id: 7,
      recipient_id: 3,
      link: '/patch-10/resource/5?commentId=11'
    })
    // mention 深链同样指向资源页
    expect(createMentionMessageMock).toHaveBeenCalledWith(
      'patch-10',
      'Patch',
      11,
      7,
      'user',
      'comment',
      5
    )
    // 上传者通知写入后失效其未读缓存
    expect(invalidateUnreadMock).toHaveBeenCalledWith(3)
    expect(createLinkDedupMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateUnreadMock.mock.invocationCallOrder[0]
    )
  })

  it('评论者是上传者本人时不发通知', async () => {
    resourceFindFirstMock.mockResolvedValue({ user_id: 7 })

    await createPatchComment(resourceInput, 7, 2)

    expect(createLinkDedupMessageMock).not.toHaveBeenCalled()
    expect(createDedupMessageMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('资源不可见或不属于该 patch 时返回错误字符串', async () => {
    resourceFindFirstMock.mockResolvedValue(null)

    const result = await createPatchComment(resourceInput, 7, 2)

    expect(result).toBe('未找到该资源')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('资源评论不失效补丁详情缓存 (资源评论不计入 _count.comment)', async () => {
    await createPatchComment(resourceInput, 7, 2)

    expect(invalidateContentMock).not.toHaveBeenCalled()
  })

  it('回复继承父评论的 resource_id 并校验可见性, 忽略 body 传入值', async () => {
    parentFindFirstMock.mockResolvedValue({
      user_id: 9,
      content: 'parent',
      status: 0,
      resource_id: 42
    })
    createCommentMock.mockResolvedValue({
      ...comment,
      parent_id: 6,
      resource_id: 42
    })

    await createPatchComment({ ...input, parentId: 6, resourceId: 5 }, 7, 2)

    // 父查询带 patch_id, 防跨补丁回复
    expect(parentFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 6, patch_id: 10 }
      })
    )
    // 可见性按父评论继承的 resource_id (42) 校验, 而非 body 的 5
    expect(resourceFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 42, patch_id: 10 })
      })
    )
    expect(createCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resource_id: 42, parent_id: 6 })
      })
    )
    // 回复通知父评论作者, 深链到资源页
    expect(createDedupMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_id: 9,
        link: '/patch-10/resource/42?commentId=11'
      })
    )
  })

  it('资源被隐藏后其评论不可回复', async () => {
    parentFindFirstMock.mockResolvedValue({
      user_id: 9,
      content: 'parent',
      status: 0,
      resource_id: 42
    })
    resourceFindFirstMock.mockResolvedValue(null)

    const result = await createPatchComment({ ...input, parentId: 6 }, 7, 2)

    expect(result).toBe('未找到该资源')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('普通评论 (无 resourceId) 不查资源、通知深链保持游戏页格式', async () => {
    parentFindFirstMock.mockResolvedValue({
      user_id: 9,
      content: 'parent',
      status: 0,
      resource_id: null
    })

    await createPatchComment({ ...input, parentId: 6 }, 7, 2)

    expect(resourceFindFirstMock).not.toHaveBeenCalled()
    expect(createDedupMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        link: '/patch-10?tab=comments&commentId=11'
      })
    )
  })
})
