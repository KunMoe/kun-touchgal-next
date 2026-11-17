import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findAdminMock,
  findAppealMock,
  findRatingMock,
  findResourceMock,
  findCommentMock,
  transactionMock,
  claimAppealMock,
  updateRatingMock,
  deleteRatingMock,
  deleteResourceMock,
  updateResourceMock,
  txLinkFindManyMock,
  updateLinkMock,
  deleteCommentMock,
  updateCommentMock,
  txFindCommentMock,
  txQueryRawMock,
  renderForWriteMock,
  onCommentPublishedMock,
  createMessageMock,
  createLogMock,
  recomputeOneMock,
  deletePendingTasksMock,
  deletePendingAppealsMock,
  deleteOrphanReportsMock,
  isPrismaConflictMock,
  invalidateContentMock,
  invalidateContentByPatchIdMock,
  invalidateCommentCacheMock,
  invalidateResourceDetailMock,
  invalidateResourceListMock,
  recalcTypeMock,
  enqueueOutboxMock,
  enqueueLinkDelMock,
  sanitizeLinksMock,
  queueSearchSyncMock,
  kickDrainMock
} = vi.hoisted(() => ({
  findAdminMock: vi.fn(),
  findAppealMock: vi.fn(),
  findRatingMock: vi.fn(),
  findResourceMock: vi.fn(),
  findCommentMock: vi.fn(),
  transactionMock: vi.fn(),
  claimAppealMock: vi.fn(),
  updateRatingMock: vi.fn(),
  deleteRatingMock: vi.fn(),
  deleteResourceMock: vi.fn(),
  updateResourceMock: vi.fn(),
  txLinkFindManyMock: vi.fn(),
  updateLinkMock: vi.fn(),
  deleteCommentMock: vi.fn(),
  updateCommentMock: vi.fn(),
  txFindCommentMock: vi.fn(),
  renderForWriteMock: vi.fn(),
  onCommentPublishedMock: vi.fn(),
  txQueryRawMock: vi.fn(),
  createMessageMock: vi.fn(),
  createLogMock: vi.fn(),
  recomputeOneMock: vi.fn(),
  deletePendingTasksMock: vi.fn(),
  deletePendingAppealsMock: vi.fn(),
  deleteOrphanReportsMock: vi.fn(),
  isPrismaConflictMock: vi.fn(),
  invalidateContentMock: vi.fn(),
  invalidateContentByPatchIdMock: vi.fn(),
  invalidateCommentCacheMock: vi.fn(),
  invalidateResourceDetailMock: vi.fn(),
  invalidateResourceListMock: vi.fn(),
  recalcTypeMock: vi.fn(),
  enqueueOutboxMock: vi.fn(),
  enqueueLinkDelMock: vi.fn(),
  sanitizeLinksMock: vi.fn(),
  queueSearchSyncMock: vi.fn(),
  kickDrainMock: vi.fn()
}))

const events: string[] = []
let recomputeStarted: Promise<void>
let finishRecompute: () => void
const transactionClient = {
  moderation_appeal: { updateMany: claimAppealMock },
  patch_rating: { updateMany: updateRatingMock, deleteMany: deleteRatingMock },
  patch_resource: {
    deleteMany: deleteResourceMock,
    updateMany: updateResourceMock
  },
  patch_resource_link: {
    findMany: txLinkFindManyMock,
    update: updateLinkMock
  },
  patch_comment: {
    deleteMany: deleteCommentMock,
    updateMany: updateCommentMock,
    findUnique: txFindCommentMock
  },
  admin_log: { create: createLogMock },
  $queryRaw: txQueryRawMock
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findUnique: findAdminMock },
    moderation_appeal: { findUnique: findAppealMock },
    patch_rating: { findUnique: findRatingMock },
    patch_resource: { findUnique: findResourceMock },
    patch_comment: { findUnique: findCommentMock },
    $transaction: transactionMock
  },
  isPrismaTransactionConflict: isPrismaConflictMock
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdownForWrite: renderForWriteMock
}))

vi.mock('~/server/content/comment/publish', () => ({
  onCommentPublished: onCommentPublishedMock
}))

vi.mock('~/app/api/patch/rating/stat', () => ({
  recomputePatchRatingStat: recomputeOneMock
}))

vi.mock('~/server/moderation/submit', () => ({
  deletePendingModerationTasks: deletePendingTasksMock
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: deletePendingAppealsMock
}))

vi.mock('~/server/report/pending', () => ({
  deleteOrphanReports: deleteOrphanReportsMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentMock,
  invalidatePatchContentCacheByPatchId: invalidateContentByPatchIdMock
}))

vi.mock('~/app/api/patch/comment/cache', () => ({
  invalidatePatchCommentCache: invalidateCommentCacheMock
}))

vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: invalidateResourceDetailMock
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: invalidateResourceListMock
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  recalcPatchType: recalcTypeMock,
  enqueueResourceLinkDeletions: enqueueLinkDelMock,
  sanitizeResourceLinksForAuditLog: sanitizeLinksMock
}))

vi.mock('~/server/search/sync', () => ({
  queueSearchSync: queueSearchSyncMock,
  enqueueSearchOutbox: enqueueOutboxMock
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: kickDrainMock
}))

import { handleAppeal } from '~/app/api/admin/appeal/handle'
import { APPEAL_RESULT_NOTICE } from '~/constants/appeal'
import { MODERATION_CONTENT_TYPE_MAP } from '~/constants/moderation'

const ratingAppeal = {
  id: 1,
  content_type: 'rating',
  content_id: 5,
  user_id: 7,
  status: 'pending',
  payload: { text: 'restored' }
}

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  const started = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  recomputeStarted = started.promise
  finishRecompute = () => {
    events.push('recompute')
    finished.resolve()
  }
  findAdminMock.mockResolvedValue({ id: 99, name: 'admin' })
  findAppealMock.mockResolvedValue(ratingAppeal)
  findRatingMock.mockResolvedValue({ patch_id: 10 })
  findResourceMock.mockResolvedValue({
    patch_id: 10,
    patch: { name: 'p' },
    links: []
  })
  findCommentMock.mockResolvedValue({ patch_id: 10 })
  claimAppealMock.mockResolvedValue({ count: 1 })
  updateRatingMock.mockResolvedValue({ count: 1 })
  deleteRatingMock.mockResolvedValue({ count: 1 })
  deleteResourceMock.mockResolvedValue({ count: 1 })
  updateResourceMock.mockResolvedValue({ count: 1 })
  updateLinkMock.mockResolvedValue({})
  deleteCommentMock.mockResolvedValue({ count: 1 })
  updateCommentMock.mockResolvedValue({ count: 1 })
  renderForWriteMock.mockResolvedValue({ html: '<p>ok</p>', version: 2 })
  onCommentPublishedMock.mockResolvedValue(undefined)
  txLinkFindManyMock.mockResolvedValue([])
  txFindCommentMock.mockResolvedValue(null)
  txQueryRawMock.mockResolvedValue([{ status: 2 }])
  createMessageMock.mockResolvedValue({})
  createLogMock.mockResolvedValue({})
  deletePendingTasksMock.mockResolvedValue({ count: 0 })
  deletePendingAppealsMock.mockResolvedValue({ count: 0 })
  deleteOrphanReportsMock.mockResolvedValue(undefined)
  isPrismaConflictMock.mockReturnValue(false)
  invalidateContentMock.mockResolvedValue(undefined)
  invalidateContentByPatchIdMock.mockResolvedValue(undefined)
  invalidateCommentCacheMock.mockResolvedValue(undefined)
  invalidateResourceDetailMock.mockResolvedValue(undefined)
  invalidateResourceListMock.mockResolvedValue(undefined)
  recalcTypeMock.mockResolvedValue('unique-x')
  enqueueOutboxMock.mockResolvedValue(undefined)
  enqueueLinkDelMock.mockResolvedValue(undefined)
  sanitizeLinksMock.mockReturnValue([])
  queueSearchSyncMock.mockReturnValue(undefined)
  kickDrainMock.mockReturnValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      events.push('transaction-start')
      const result = await callback(transactionClient)
      events.push('transaction-commit')
      return result
    }
  )
  recomputeOneMock.mockImplementation(() => {
    started.resolve()
    return finished.promise
  })
})

describe('handleAppeal approve', () => {
  it('recomputes rating stats before an approval transaction commits', async () => {
    const result = handleAppeal({ appealId: 1, approve: true }, 99)
    await recomputeStarted
    await Promise.resolve()
    const eventsBeforeRecompute = [...events]
    finishRecompute()

    await expect(result).resolves.toEqual({})
    expect(recomputeOneMock).toHaveBeenCalledWith(10, transactionClient)
    expect(updateRatingMock.mock.invocationCallOrder[0]).toBeLessThan(
      recomputeOneMock.mock.invocationCallOrder[0]
    )
    expect(eventsBeforeRecompute).toEqual(['transaction-start'])
    expect(events).toEqual([
      'transaction-start',
      'recompute',
      'transaction-commit'
    ])
  })
})

describe('handleAppeal approve comment', () => {
  const commentAppeal = {
    ...ratingAppeal,
    content_type: 'comment',
    payload: { text: '改过的评论' }
  }

  beforeEach(() => {
    findAppealMock.mockResolvedValue(commentAppeal)
  })

  it('writes the appealed text together with its rendered html and version', async () => {
    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    expect(renderForWriteMock).toHaveBeenCalledWith('comment', '改过的评论')
    expect(updateCommentMock).toHaveBeenCalledWith({
      where: { id: 5, status: 2 },
      data: {
        content: '改过的评论',
        content_html: '<p>ok</p>',
        content_html_version: 2,
        edit: expect.any(String),
        status: 0
      }
    })
    expect(onCommentPublishedMock).toHaveBeenCalledWith(5)
    // 缓存先、通知后: 通知出问题不该连累缓存失效
    const notified = onCommentPublishedMock.mock.invocationCallOrder[0]
    expect(invalidateCommentCacheMock.mock.invocationCallOrder[0]).toBeLessThan(
      notified
    )
    expect(
      invalidateContentByPatchIdMock.mock.invocationCallOrder[0]
    ).toBeLessThan(notified)
  })

  // 提交入口已拒收渲染不出来的正文; 这里兜住在那之前提交的申诉。管理员改不了申诉
  // 载荷, 所以给的是他能照做的提示, 不是给作者看的「请精简后再提交」
  it('refuses to approve text that cannot be rendered, leaving the appeal pending', async () => {
    renderForWriteMock.mockResolvedValue(
      '评论中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toBe('申诉提交的正文无法渲染, 无法通过, 可拒绝该申诉以关闭')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(invalidateCommentCacheMock).not.toHaveBeenCalled()
  })
})

describe('handleAppeal approve resource links', () => {
  const resourceAppeal = {
    ...ratingAppeal,
    content_type: 'resource',
    payload: {
      name: '新标题',
      note: '新介绍',
      links: [
        {
          id: 21,
          storage: 's3',
          content: 'https://s3.example/payload-copy.zip',
          size: '700 MB',
          code: '',
          password: 'pw-1'
        },
        {
          id: 22,
          storage: 'user',
          content: 'https://pan.example/s/new',
          size: '2 GB',
          code: 'c0de',
          password: ''
        }
      ]
    }
  }

  beforeEach(() => {
    findAppealMock.mockResolvedValue(resourceAppeal)
    txLinkFindManyMock.mockResolvedValue([
      { id: 21, storage: 's3' },
      { id: 22, storage: 'user' }
    ])
  })

  it('writes the appealed link fields back after the resource row is locked', async () => {
    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    expect(updateResourceMock).toHaveBeenCalledWith({
      where: { id: 5, status: 1 },
      data: { name: '新标题', note: '新介绍', status: 0 }
    })
    expect(renderForWriteMock).toHaveBeenCalledWith('note', '新介绍')
    // 链接行在资源行的条件写 (取得行锁) 之后才读写, 与资源编辑的加锁顺序一致
    expect(updateResourceMock.mock.invocationCallOrder[0]).toBeLessThan(
      txLinkFindManyMock.mock.invocationCallOrder[0]
    )
    expect(txLinkFindManyMock).toHaveBeenCalledWith({
      where: { resource_id: 5 },
      select: { id: true, storage: true }
    })
    expect(updateLinkMock).toHaveBeenCalledTimes(2)
    expect(updateLinkMock).toHaveBeenCalledWith({
      where: { id: 22 },
      data: {
        content: 'https://pan.example/s/new',
        size: '2 GB',
        code: 'c0de',
        password: ''
      }
    })
  })

  it('refuses to approve a note that cannot be rendered', async () => {
    renderForWriteMock.mockResolvedValue(
      '资源备注中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toBe('申诉提交的正文无法渲染, 无法通过, 可拒绝该申诉以关闭')
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('links the approved notice to the appeal page filtered to approved appeals', async () => {
    await handleAppeal({ appealId: 1, approve: true }, 99)

    // 申诉页默认只显示可申诉内容, 不带状态就看不到刚通过的这一条
    expect(createMessageMock.mock.calls[0][0].link).toBe(
      '/settings/user?tab=appeal&state=approved'
    )
  })

  it('never writes the address of an s3 link, whatever the payload carries', async () => {
    await handleAppeal({ appealId: 1, approve: true }, 99)

    // 站内存储的地址由服务端在绑定上传对象时生成: 只写大小与两个口令
    expect(updateLinkMock).toHaveBeenCalledWith({
      where: { id: 21 },
      data: { size: '700 MB', code: '', password: 'pw-1' }
    })
  })

  it('decides by the stored storage type, not the one recorded in the payload', async () => {
    txLinkFindManyMock.mockResolvedValue([
      { id: 21, storage: 's3' },
      { id: 22, storage: 's3' }
    ])

    await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(updateLinkMock).toHaveBeenCalledWith({
      where: { id: 22 },
      data: { size: '2 GB', code: 'c0de', password: '' }
    })
  })

  // TouchGal 资源盘的链接只有超级管理员能写: 申诉通过时整条不动
  it('does not write a TouchGal link row at all', async () => {
    txLinkFindManyMock.mockResolvedValue([
      { id: 21, storage: 's3' },
      { id: 22, storage: 'touchgal' }
    ])

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    expect(updateLinkMock).toHaveBeenCalledTimes(1)
    expect(updateLinkMock.mock.calls[0][0].where).toEqual({ id: 21 })
  })

  it.each([
    ['a link row was replaced', [{ id: 21 }, { id: 30 }]],
    ['a link row was removed', [{ id: 21 }]],
    ['a link row was added', [{ id: 21 }, { id: 22 }, { id: 23 }]]
  ])('refuses to approve when %s after the appeal', async (_, rows) => {
    txLinkFindManyMock.mockResolvedValue(
      rows.map((row) => ({ ...row, storage: 'user' }))
    )

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    // 管理员复核的内容对不上现有链接: 整体失败, 不部分套用, 不通知不记日志
    // 拒绝申诉会删除仍隐藏的资源, 文案里带上不删资源的处理办法
    expect(result).toBe(
      '资源链接在申诉提交后已变更, 无法通过该申诉。如需保留该资源, 请先在下载资源管理中恢复它, 再拒绝本申诉'
    )
    expect(updateLinkMock).not.toHaveBeenCalled()
    expect(createMessageMock).not.toHaveBeenCalled()
    expect(createLogMock).not.toHaveBeenCalled()
    expect(invalidateResourceDetailMock).not.toHaveBeenCalled()
  })

  it('writes the model name back only where the stored type is an AI patch', async () => {
    findAppealMock.mockResolvedValue({
      ...resourceAppeal,
      payload: { ...resourceAppeal.payload, modelName: 'DeepSeek-V3' }
    })

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    expect(updateResourceMock).toHaveBeenCalledTimes(2)
    // 模型型号只属于 AI 翻译补丁: 以库中的类型为条件写, 不看载荷
    expect(updateResourceMock).toHaveBeenLastCalledWith({
      where: { id: 5, type: { has: 'ai' } },
      data: { model_name: 'DeepSeek-V3' }
    })
    // 先由带状态条件的写取得资源行锁并确认仍是隐藏态
    expect(updateResourceMock.mock.calls[0][0]).toEqual({
      where: { id: 5, status: 1 },
      data: { name: '新标题', note: '新介绍', status: 0 }
    })
  })

  it('does not write the model name when the resource is no longer hidden', async () => {
    findAppealMock.mockResolvedValue({
      ...resourceAppeal,
      payload: { ...resourceAppeal.payload, modelName: 'DeepSeek-V3' }
    })
    updateResourceMock.mockResolvedValue({ count: 0 })

    await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(updateResourceMock).toHaveBeenCalledTimes(1)
  })

  it('leaves link rows alone for an appeal submitted before links were editable', async () => {
    findAppealMock.mockResolvedValue({
      ...resourceAppeal,
      payload: { name: '新标题', note: '新介绍' }
    })

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    expect(updateResourceMock).toHaveBeenCalledTimes(1)
    expect(txLinkFindManyMock).not.toHaveBeenCalled()
    expect(updateLinkMock).not.toHaveBeenCalled()
  })

  it('does not touch link rows when the resource is no longer hidden', async () => {
    updateResourceMock.mockResolvedValue({ count: 0 })

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toBe(
      '内容已不存在或状态已变更, 无法通过, 可拒绝该申诉以关闭'
    )
    expect(txLinkFindManyMock).not.toHaveBeenCalled()
    expect(updateLinkMock).not.toHaveBeenCalled()
  })
})

describe('handleAppeal reject', () => {
  it('deletes a still-hidden rating and writes notice + audit inside the transaction', async () => {
    txQueryRawMock.mockResolvedValue([{ status: 2 }])

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    // 守卫删除: FOR UPDATE 读到隐藏态才删 (R1)
    expect(deleteRatingMock).toHaveBeenCalledWith({ where: { id: 5 } })
    // 举报外键 SET NULL: 删除后按 NULL 目标清理级联置空的孤儿 (锁序一致)
    expect(deleteOrphanReportsMock).toHaveBeenCalledWith(
      'rating',
      transactionClient
    )
    expect(deleteRatingMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteOrphanReportsMock.mock.invocationCallOrder[0]
    )
    // R3: 通知与审计随删除同事务 —— createMessage 收到 tx, admin_log 写在 tx 上
    expect(createMessageMock).toHaveBeenCalledTimes(1)
    expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
    expect(createMessageMock.mock.calls[0][0].content).toBe(
      APPEAL_RESULT_NOTICE.rejected(MODERATION_CONTENT_TYPE_MAP.rating)
    )
    expect(createLogMock).toHaveBeenCalledTimes(1)
    expect(deleteRatingMock.mock.invocationCallOrder[0]).toBeLessThan(
      createMessageMock.mock.invocationCallOrder[0]
    )
    // didDelete=true 才触发提交后缓存失效
    expect(invalidateContentByPatchIdMock).toHaveBeenCalledWith(10)
  })

  it('keeps a restored rating and sends the "kept" notice without deleting', async () => {
    // FOR UPDATE 读到已恢复 (status 0): 并发恢复赢得竞态, 不得删除 (R1)
    txQueryRawMock.mockResolvedValue([{ status: 0 }])

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    expect(deleteRatingMock).not.toHaveBeenCalled()
    // 内容保留 → 其举报仍有效, 不得清理
    expect(deleteOrphanReportsMock).not.toHaveBeenCalled()
    expect(createMessageMock.mock.calls[0][0].content).toBe(
      APPEAL_RESULT_NOTICE.rejectedKept(MODERATION_CONTENT_TYPE_MAP.rating)
    )
    expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
    // 未删除 → 不触发提交后副作用
    expect(invalidateContentByPatchIdMock).not.toHaveBeenCalled()
  })

  it('closes the appeal without side effects when the rating is already gone', async () => {
    // 内容已被并发删除: 达到拒绝目标, 关闭申诉但不重复删、不做副作用
    txQueryRawMock.mockResolvedValue([])

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    expect(deleteRatingMock).not.toHaveBeenCalled()
    expect(createMessageMock.mock.calls[0][0].content).toBe(
      APPEAL_RESULT_NOTICE.rejected(MODERATION_CONTENT_TYPE_MAP.rating)
    )
    expect(invalidateContentByPatchIdMock).not.toHaveBeenCalled()
  })

  it('returns an error and touches nothing when the appeal was already handled', async () => {
    // claim 失败: 抛错整体回滚, 不删不通知, 无 revertClaim 造孤儿 (R2)
    claimAppealMock.mockResolvedValue({ count: 0 })

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toBe('该申诉已被处理, 请刷新后重试')
    expect(deleteRatingMock).not.toHaveBeenCalled()
    expect(createMessageMock).not.toHaveBeenCalled()
    expect(createLogMock).not.toHaveBeenCalled()
  })

  it('guards the resource delete by hidden status and fires post-commit effects', async () => {
    findAppealMock.mockResolvedValue({
      ...ratingAppeal,
      content_type: 'resource'
    })
    // FOR UPDATE 锁下读到隐藏态 (resource 为 1) 才删, 闭合并发取消隐藏窗口 (R1)
    txQueryRawMock.mockResolvedValue([{ status: 1 }])
    // S3 入队以锁下重读的 links 为事实源, 而非事务外快照 (并发重绑会换 s3 对象)
    txLinkFindManyMock.mockResolvedValue([
      { storage: 's3', content: 'c-1', hash: 'h-1', s3_key: 'k-1' },
      { storage: 'user', content: 'u-1', hash: '', s3_key: '' }
    ])

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    // 锁下已确认状态, 删除本身不再需要 status 条件 (对齐 rating 分支)
    expect(deleteResourceMock).toHaveBeenCalledWith({
      where: { id: 5 }
    })
    expect(enqueueLinkDelMock).toHaveBeenCalledWith(transactionClient, [
      { content: 'c-1', patchId: 10, hash: 'h-1', s3Key: 'k-1' }
    ])
    expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
    // 删除成功的提交后副作用
    expect(queueSearchSyncMock).toHaveBeenCalledWith(10)
    expect(invalidateContentMock).toHaveBeenCalledWith('unique-x')
    expect(kickDrainMock).toHaveBeenCalledTimes(1)
  })

  it('does not delete a resource that was restored before the transaction', async () => {
    findAppealMock.mockResolvedValue({
      ...ratingAppeal,
      content_type: 'resource'
    })
    // FOR UPDATE 读到已恢复 (status 0): 并发恢复赢得竞态, 内容保留
    txQueryRawMock.mockResolvedValue([{ status: 0 }])

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(deleteResourceMock).not.toHaveBeenCalled()

    expect(result).toEqual({})
    expect(createMessageMock.mock.calls[0][0].content).toBe(
      APPEAL_RESULT_NOTICE.rejectedKept(MODERATION_CONTENT_TYPE_MAP.resource)
    )
    // 资源保留 → 其评论仍在, 其举报不得清理
    expect(deleteOrphanReportsMock).not.toHaveBeenCalled()
    expect(queueSearchSyncMock).not.toHaveBeenCalled()
    expect(kickDrainMock).not.toHaveBeenCalled()
  })

  it('cleans orphaned resource-comment reports after the delete', async () => {
    findAppealMock.mockResolvedValue({
      ...ratingAppeal,
      content_type: 'resource'
    })
    txQueryRawMock.mockResolvedValue([{ status: 1 }])

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    // 级联删资源评论后举报外键已置 NULL, 按 NULL 目标清理孤儿
    expect(deleteOrphanReportsMock).toHaveBeenCalledWith(
      'comment',
      transactionClient
    )
    expect(deleteResourceMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteOrphanReportsMock.mock.invocationCallOrder[0]
    )
  })

  it('guards the comment delete by hidden status and cleans descendants', async () => {
    findAppealMock.mockResolvedValue({
      ...ratingAppeal,
      content_type: 'comment'
    })
    // CTE 返回根+后代 id
    txQueryRawMock.mockResolvedValue([{ id: 5 }, { id: 6 }])

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    // 守卫删除条件含 status: 2 (comment 隐藏态)
    expect(deleteCommentMock).toHaveBeenCalledWith({
      where: { id: 5, status: 2 }
    })
    // 删除后按收集到的根+后代 id 清理审核任务与 pending 申诉
    expect(deletePendingTasksMock).toHaveBeenCalledWith(
      'comment',
      [5, 6],
      transactionClient
    )
    expect(deletePendingAppealsMock).toHaveBeenCalledWith(
      'comment',
      [5, 6],
      transactionClient
    )
    // 举报外键 SET NULL: 删除后按 NULL 目标清理级联置空的孤儿
    expect(deleteOrphanReportsMock).toHaveBeenCalledWith(
      'comment',
      transactionClient
    )
    expect(deleteCommentMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteOrphanReportsMock.mock.invocationCallOrder[0]
    )
    expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
    expect(invalidateCommentCacheMock).toHaveBeenCalledWith(10)
  })
})
