import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createCommentMock,
  lockMock,
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
  lockMock: vi.fn(),
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
  $queryRaw: lockMock,
  $executeRaw: lockMock,
  patch_comment: {
    create: createCommentMock
  }
}

// 事务里各条取锁语句读到的行, 按表区分
const locked: { resource: unknown[]; parent: unknown[] } = {
  resource: [],
  parent: []
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

import { Prisma } from '~/prisma/generated/prisma/client'
import { commentSubject } from '~/server/moderation/subject'
import { createPatchComment } from '~/app/api/patch/comment/create'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'

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
  locked.resource = [{ id: 5 }]
  locked.parent = [{ status: 0 }]
  lockMock.mockImplementation(async (template: string[]) => {
    const sql = template.join('?')
    return sql.includes('FROM patch_resource')
      ? locked.resource
      : sql.includes('FROM patch_comment')
        ? locked.parent
        : [{ id: 10 }]
  })
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

    const actor = kunTestActor({ uid: 7, role: 2 })
    const creation = createPatchComment(input, actor)

    expect(planTextModerationMock).toHaveBeenCalledWith(
      commentSubject('comment'),
      { actor }
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

    const result = await createPatchComment(
      input,
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(result).toBe(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )
    expect(renderForWriteMock).toHaveBeenCalledWith('comment', 'comment')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(onCommentPublishedMock).not.toHaveBeenCalled()
    expect(invalidateContentMock).not.toHaveBeenCalled()
  })

  it('提交者在途的审核任务已到上限时原样返回拒绝消息, 什么都不写', async () => {
    planTextModerationMock.mockResolvedValueOnce(
      '您已有 10 条内容在等待审核, 请等审核完成后再提交'
    )

    const result = await createPatchComment(
      input,
      kunTestActor({ uid: 7, role: 1 })
    )

    expect(result).toBe('您已有 10 条内容在等待审核, 请等审核完成后再提交')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(enqueueTextModerationMock).not.toHaveBeenCalled()
    expect(onCommentPublishedMock).not.toHaveBeenCalled()
    expect(invalidateContentMock).not.toHaveBeenCalled()
  })

  it('评论创建后按 unique_id 失效补丁详情缓存 (M-05)', async () => {
    await createPatchComment(input, kunTestActor({ uid: 7, role: 2 }))

    expect(invalidateContentMock).toHaveBeenCalledWith('patch-10')
  })

  it('创建评论时把调用者角色透传给审核预筛', async () => {
    const actor = kunTestActor({ uid: 7, role: 3 })
    await createPatchComment(input, actor)

    expect(planTextModerationMock).toHaveBeenCalledWith(
      commentSubject('comment'),
      { actor }
    )
    // 透传的就是调用方给的操作者 (同一对象)
    expect(planTextModerationMock.mock.calls[0][1].actor).toBe(actor)
  })

  // 通知的对象与文案由 server/content/comment/publish 决定, 这里只管何时调用
  it('未被拦截时在两份缓存失效之后发通知', async () => {
    await createPatchComment(input, kunTestActor({ uid: 7, role: 2 }))

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

    await createPatchComment(
      { ...input, parentId: 6 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(onCommentPublishedMock).not.toHaveBeenCalled()
    // 待审评论照样失效缓存 (创建路径的既有行为)
    expect(invalidateCommentCacheMock).toHaveBeenCalledWith(10)
  })
})

// 补丁的一级评论不取任何行锁, 补丁不存在或被并发删除时由 INSERT 的外键检查发现
describe('createPatchComment 撞外键', () => {
  it('P2003 回滚并返回「未找到 Galgame」, 不失效缓存、不发通知', async () => {
    createCommentMock.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', {
        code: 'P2003',
        clientVersion: 'test'
      })
    )

    await expect(
      createPatchComment(input, kunTestActor({ uid: 7, role: 1 }))
    ).resolves.toBe('未找到 Galgame')
    expect(invalidateCommentCacheMock).not.toHaveBeenCalled()
    expect(invalidateContentMock).not.toHaveBeenCalled()
    expect(onCommentPublishedMock).not.toHaveBeenCalled()
  })

  it('其它异常原样抛出', async () => {
    const boom = new Error('connection lost')
    createCommentMock.mockRejectedValue(boom)

    await expect(
      createPatchComment(input, kunTestActor({ uid: 7, role: 1 }))
    ).rejects.toBe(boom)
  })
})

// 事务外的预检之后, 资源或父评论可能被删、被隐藏。删除命令锁着这些行: 不在事务里
// 先确认的话, INSERT 的外键检查要等删除提交后才失败, 调用方看到的是 500
describe('createPatchComment 事务内的行锁', () => {
  const lockSql = () =>
    lockMock.mock.calls.map(([template]) =>
      (template as string[]).join('?').replace(/\s+/g, ' ').trim()
    )
  const RESOURCE_LOCK =
    'SELECT id FROM patch_resource WHERE id = ? FOR KEY SHARE'
  const PATCH_LOCK = 'SELECT id FROM patch WHERE id = ? FOR KEY SHARE'
  const PARENT_LOCK =
    'SELECT status FROM patch_comment WHERE id = ? FOR KEY SHARE'

  beforeEach(() => {
    parentFindFirstMock.mockResolvedValue({ status: 0, resource_id: null })
    resourceFindFirstMock.mockResolvedValue({ id: 5 })
  })

  it('回复: 先锁补丁行、再锁父评论, 然后才插入', async () => {
    await createPatchComment(
      { ...input, parentId: 6 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(lockSql()).toEqual([PATCH_LOCK, PARENT_LOCK])
    expect(lockMock.mock.calls.map((call) => call[1])).toEqual([10, 6])
    expect(lockMock.mock.invocationCallOrder[1]).toBeLessThan(
      createCommentMock.mock.invocationCallOrder[0]
    )
  })

  // 与级联删除同向 (资源 → 补丁 → 评论): 先锁父评论的话, 删资源的事务锁着资源行去
  // 级联删评论, 这里锁着评论行去等资源行, 两边互等
  it('回复资源评论区的评论: 资源行最先, 然后补丁行、父评论', async () => {
    parentFindFirstMock.mockResolvedValue({ status: 0, resource_id: 5 })

    await createPatchComment(
      { ...input, parentId: 6 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(lockSql()).toEqual([RESOURCE_LOCK, PATCH_LOCK, PARENT_LOCK])
    expect(lockMock.mock.calls.map((call) => call[1])).toEqual([5, 10, 6])
  })

  it('资源的一级评论只锁资源行', async () => {
    await createPatchComment(
      { ...input, resourceId: 5 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(lockSql()).toEqual([RESOURCE_LOCK])
    expect(createCommentMock).toHaveBeenCalledTimes(1)
  })

  it('补丁的一级评论不取任何行锁', async () => {
    await createPatchComment(input, kunTestActor({ uid: 7, role: 2 }))

    expect(lockMock).not.toHaveBeenCalled()
    expect(createCommentMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['已不存在', [], '未找到该评论'],
    ['转为待审核', [{ status: 1 }], '该评论正在审核中, 暂时无法回复'],
    ['已被隐藏', [{ status: 2 }], '未找到该评论']
  ])(
    '锁下父评论%s: 返回与预检相同的提示, 不插入、不送审、不发通知、不失效缓存',
    async (_label, parentRows, message) => {
      locked.parent = parentRows
      planTextModerationMock.mockResolvedValue({
        queue: true,
        intercept: false,
        dryRun: true
      })

      const result = await createPatchComment(
        { ...input, parentId: 6 },
        kunTestActor({ uid: 7, role: 2 })
      )

      expect(result).toBe(message)
      expect(createCommentMock).not.toHaveBeenCalled()
      expect(enqueueTextModerationMock).not.toHaveBeenCalled()
      expect(onCommentPublishedMock).not.toHaveBeenCalled()
      expect(invalidateCommentCacheMock).not.toHaveBeenCalled()
    }
  )

  it('锁下资源已不存在: 返回「未找到该资源」, 不再去锁评论', async () => {
    parentFindFirstMock.mockResolvedValue({ status: 0, resource_id: 5 })
    locked.resource = []

    const result = await createPatchComment(
      { ...input, parentId: 6 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(result).toBe('未找到该资源')
    expect(lockSql()).toEqual([RESOURCE_LOCK])
    expect(createCommentMock).not.toHaveBeenCalled()
  })
})

describe('createPatchComment 资源评论', () => {
  const resourceInput = { ...input, resourceId: 5 }

  beforeEach(() => {
    resourceFindFirstMock.mockResolvedValue({ id: 5 })
    createCommentMock.mockResolvedValue({ ...comment, resource_id: 5 })
  })

  it('顶层资源评论落库 resource_id 并发通知', async () => {
    await createPatchComment(resourceInput, kunTestActor({ uid: 7, role: 2 }))

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

    const result = await createPatchComment(
      resourceInput,
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(result).toBe('未找到该资源')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('资源评论不失效补丁详情缓存 (资源评论不计入 _count.comment)', async () => {
    await createPatchComment(resourceInput, kunTestActor({ uid: 7, role: 2 }))

    expect(invalidateContentMock).not.toHaveBeenCalled()
  })

  it('回复继承父评论的 resource_id 并校验可见性, 忽略 body 传入值', async () => {
    parentFindFirstMock.mockResolvedValue({ status: 0, resource_id: 42 })
    createCommentMock.mockResolvedValue({
      ...comment,
      parent_id: 6,
      resource_id: 42
    })

    await createPatchComment(
      { ...input, parentId: 6, resourceId: 5 },
      kunTestActor({ uid: 7, role: 2 })
    )

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

    const result = await createPatchComment(
      { ...input, parentId: 6 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(result).toBe('未找到该资源')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('普通评论 (无 resourceId) 不查资源', async () => {
    parentFindFirstMock.mockResolvedValue({ status: 0, resource_id: null })

    await createPatchComment(
      { ...input, parentId: 6 },
      kunTestActor({ uid: 7, role: 2 })
    )

    expect(resourceFindFirstMock).not.toHaveBeenCalled()
  })
})
