import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createCommentMock,
  transactionMock,
  renderForWriteMock,
  planTextModerationMock,
  enqueueTextModerationMock,
  onCommentPublishedMock,
  invalidateCommentCacheMock,
  invalidateContentMock,
  parentFindFirstMock,
  resourceFindFirstMock
} = vi.hoisted(() => ({
  createCommentMock: vi.fn(),
  transactionMock: vi.fn(),
  renderForWriteMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  enqueueTextModerationMock: vi.fn(),
  onCommentPublishedMock: vi.fn(async () => undefined),
  invalidateCommentCacheMock: vi.fn(async () => undefined),
  invalidateContentMock: vi.fn(async () => undefined),
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

vi.mock('~/server/content/comment/publish', () => ({
  onCommentPublished: onCommentPublishedMock
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: invalidateCommentCacheMock
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdownForWrite: renderForWriteMock
}))

vi.mock('~/server/moderation/submit', () => ({
  enqueueTextModeration: enqueueTextModerationMock,
  planTextModeration: planTextModerationMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentMock
}))

import { commentSubject } from '~/server/moderation/subject'
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
  renderForWriteMock.mockResolvedValue({ html: '<p>comment</p>', version: 1 })
  planTextModerationMock.mockResolvedValue({
    queue: false,
    intercept: false,
    dryRun: false
  })
  enqueueTextModerationMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

describe('createPatchComment', () => {
  it('starts moderation pre-screening before Markdown rendering completes', async () => {
    let resolveRender:
      ((rendered: { html: string; version: number }) => void) | undefined
    renderForWriteMock.mockImplementationOnce(
      () =>
        new Promise<{ html: string; version: number }>((resolve) => {
          resolveRender = resolve
        })
    )

    const creation = createPatchComment(input, 7, 2)

    expect(planTextModerationMock).toHaveBeenCalledWith(
      commentSubject('comment'),
      { userRole: 2 }
    )
    expect(transactionMock).not.toHaveBeenCalled()

    resolveRender?.({ html: '<p>comment</p>', version: 1 })
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
    // 响应直接用落库的 HTML, 提交之后不再渲染第二次
    expect(renderForWriteMock).toHaveBeenCalledTimes(1)
  })

  // 渲染不出来是由输入决定的, 重试不会成功: 不落「空 HTML + version 0」等读时重试,
  // 而是当场拒绝, 库里不收渲染不出来的正文
  it('渲染不出来的正文返回错误消息, 不进事务、不发通知、不失效缓存', async () => {
    renderForWriteMock.mockResolvedValueOnce(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )

    const result = await createPatchComment(input, 7, 2)

    expect(result).toBe(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )
    expect(renderForWriteMock).toHaveBeenCalledWith('comment', 'comment')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(onCommentPublishedMock).not.toHaveBeenCalled()
    expect(invalidateContentMock).not.toHaveBeenCalled()
  })

  it('评论创建后按 unique_id 失效补丁详情缓存 (M-05)', async () => {
    await createPatchComment(input, 7, 2)

    expect(invalidateContentMock).toHaveBeenCalledWith('patch-10')
  })

  it('创建评论时把调用者角色透传给审核预筛', async () => {
    await createPatchComment(input, 7, 3)

    expect(planTextModerationMock).toHaveBeenCalledWith(
      commentSubject('comment'),
      { userRole: 3 }
    )
  })

  // 通知的对象与文案由 server/content/comment/publish 决定, 这里只管何时调用
  it('未被拦截时在两份缓存失效之后发通知', async () => {
    await createPatchComment(input, 7, 2)

    expect(onCommentPublishedMock).toHaveBeenCalledWith(11)
    const notified = onCommentPublishedMock.mock.invocationCallOrder[0]
    expect(invalidateCommentCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
      notified
    )
    expect(invalidateContentMock.mock.invocationCallOrder[0]).toBeLessThan(
      notified
    )
  })

  it('被审核拦截时不发通知, 等评论对他人可见后再补', async () => {
    parentFindFirstMock.mockResolvedValue({ status: 0, resource_id: null })
    planTextModerationMock.mockResolvedValue({
      queue: true,
      intercept: true,
      dryRun: false
    })

    await createPatchComment({ ...input, parentId: 6 }, 7, 2)

    expect(onCommentPublishedMock).not.toHaveBeenCalled()
    // 待审评论照样失效缓存 (创建路径的既有行为)
    expect(invalidateCommentCacheMock).toHaveBeenCalledWith(10)
  })
})

describe('createPatchComment 资源评论', () => {
  const resourceInput = { ...input, resourceId: 5 }

  beforeEach(() => {
    resourceFindFirstMock.mockResolvedValue({ id: 5 })
    createCommentMock.mockResolvedValue({ ...comment, resource_id: 5 })
  })

  it('顶层资源评论落库 resource_id 并发通知', async () => {
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
    expect(onCommentPublishedMock).toHaveBeenCalledWith(11)
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
    parentFindFirstMock.mockResolvedValue({ status: 0, resource_id: 42 })
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
  })

  it('资源被隐藏后其评论不可回复', async () => {
    parentFindFirstMock.mockResolvedValue({ status: 0, resource_id: 42 })
    resourceFindFirstMock.mockResolvedValue(null)

    const result = await createPatchComment({ ...input, parentId: 6 }, 7, 2)

    expect(result).toBe('未找到该资源')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('普通评论 (无 resourceId) 不查资源', async () => {
    parentFindFirstMock.mockResolvedValue({ status: 0, resource_id: null })

    await createPatchComment({ ...input, parentId: 6 }, 7, 2)

    expect(resourceFindFirstMock).not.toHaveBeenCalled()
  })
})
