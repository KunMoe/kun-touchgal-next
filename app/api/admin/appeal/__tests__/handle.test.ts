import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findAdminMock,
  findAppealMock,
  transactionMock,
  claimAppealMock,
  executeRawMock,
  updateResourceMock,
  txLinkFindManyMock,
  updateLinkMock,
  renderForWriteMock,
  createMessageMock,
  createLogMock,
  planCommentRemovalMock,
  executeCommentRemovalMock,
  planRatingRemovalMock,
  executeRatingRemovalMock,
  planResourceRemovalMock,
  executeResourceRemovalMock,
  transitionCommentsMock,
  transitionRatingsMock,
  transitionResourcesMock,
  invalidateUnreadMock
} = vi.hoisted(() => ({
  findAdminMock: vi.fn(),
  findAppealMock: vi.fn(),
  transactionMock: vi.fn(),
  claimAppealMock: vi.fn(),
  executeRawMock: vi.fn(),
  updateResourceMock: vi.fn(),
  txLinkFindManyMock: vi.fn(),
  updateLinkMock: vi.fn(),
  renderForWriteMock: vi.fn(),
  createMessageMock: vi.fn(),
  createLogMock: vi.fn(),
  planCommentRemovalMock: vi.fn(),
  executeCommentRemovalMock: vi.fn(),
  planRatingRemovalMock: vi.fn(),
  executeRatingRemovalMock: vi.fn(),
  planResourceRemovalMock: vi.fn(),
  executeResourceRemovalMock: vi.fn(),
  transitionCommentsMock: vi.fn(),
  transitionRatingsMock: vi.fn(),
  transitionResourcesMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const events: string[] = []
const transactionClient = {
  $executeRaw: executeRawMock,
  moderation_appeal: { updateMany: claimAppealMock },
  patch_resource: { updateMany: updateResourceMock },
  patch_resource_link: {
    findMany: txLinkFindManyMock,
    update: updateLinkMock
  },
  admin_log: { create: createLogMock }
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    user: { findUnique: findAdminMock },
    moderation_appeal: { findUnique: findAppealMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

vi.mock('~/app/api/utils/render/renderKunMarkdown', () => ({
  renderKunMarkdownForWrite: renderForWriteMock
}))

// 删除与状态迁移的锁、清理顺序、聚合重算、出箱、缓存失效与通知补发由命令自己的
// 测试覆盖; 这里只看入口怎么用它们
vi.mock('~/server/content/comment/remove', () => ({
  planCommentRemoval: planCommentRemovalMock,
  executeCommentRemoval: executeCommentRemovalMock
}))

vi.mock('~/server/content/rating/remove', () => ({
  planRatingRemoval: planRatingRemovalMock,
  executeRatingRemoval: executeRatingRemovalMock
}))

vi.mock('~/server/content/resource/remove', () => ({
  planResourceRemoval: planResourceRemovalMock,
  executeResourceRemoval: executeResourceRemovalMock
}))

vi.mock('~/server/content/comment/transition', () => ({
  transitionComments: transitionCommentsMock
}))

vi.mock('~/server/content/rating/transition', () => ({
  transitionRatings: transitionRatingsMock
}))

vi.mock('~/server/content/resource/transition', () => ({
  transitionResources: transitionResourcesMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
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

const txContext = expect.objectContaining({ tx: transactionClient })

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  findAdminMock.mockResolvedValue({ id: 99, name: 'admin' })
  findAppealMock.mockResolvedValue(ratingAppeal)
  claimAppealMock.mockResolvedValue({ count: 1 })
  executeRawMock.mockResolvedValue(1)
  updateResourceMock.mockResolvedValue({ count: 1 })
  updateLinkMock.mockResolvedValue({})
  txLinkFindManyMock.mockResolvedValue([])
  renderForWriteMock.mockResolvedValue({ html: '<p>ok</p>', version: 2 })
  createMessageMock.mockResolvedValue({})
  createLogMock.mockResolvedValue({})
  planCommentRemovalMock.mockResolvedValue({
    roots: [{ id: 5 }],
    skipped: [],
    subtree: [{ id: 5 }, { id: 6 }]
  })
  executeCommentRemovalMock.mockResolvedValue({ deletedIds: [5, 6] })
  planRatingRemovalMock.mockResolvedValue({
    rows: [{ id: 5, user_id: 7, patch_id: 10, status: 2 }],
    skipped: []
  })
  executeRatingRemovalMock.mockResolvedValue({ deletedIds: [5] })
  planResourceRemovalMock.mockResolvedValue({
    rows: [{ id: 5 }],
    skipped: [],
    refundPublishReward: false
  })
  executeResourceRemovalMock.mockResolvedValue({ deletedIds: [5] })
  transitionCommentsMock.mockResolvedValue([{ id: 5, from: 2 }])
  transitionRatingsMock.mockResolvedValue([{ id: 5, from: 2 }])
  transitionResourcesMock.mockResolvedValue([{ id: 5, from: 1 }])
  invalidateUnreadMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
      events.push('transaction-start')
      const result = await callback(transactionClient)
      events.push('transaction-commit')
      return result
    }
  )
})

describe('handleAppeal 预检', () => {
  it('管理员不存在', async () => {
    findAdminMock.mockResolvedValue(null)

    expect(await handleAppeal({ appealId: 1, approve: true }, 99)).toBe(
      '未找到该管理员'
    )
  })

  it('申诉不存在或已被处理', async () => {
    findAppealMock.mockResolvedValue(null)
    expect(await handleAppeal({ appealId: 1, approve: true }, 99)).toBe(
      '未找到该申诉'
    )

    findAppealMock.mockResolvedValue({ ...ratingAppeal, status: 'approved' })
    expect(await handleAppeal({ appealId: 1, approve: true }, 99)).toBe(
      '该申诉已被处理'
    )
    expect(transactionMock).not.toHaveBeenCalled()
  })
})

// 删除命令的顺序是「内容行 → 待处理的申诉」。申诉处理若先认领申诉行再去锁内容行,
// 与并发的删除就各拿一把、互等对方那把
describe('handleAppeal 锁序', () => {
  it.each([
    ['rating', 'patch_rating', { text: 'restored' }],
    ['comment', 'patch_comment', { text: 'restored' }],
    ['resource', 'patch_resource', { name: 'n', note: '' }]
  ])(
    '%s: 通过与拒绝都先锁内容行, 再认领申诉行',
    async (type, table, payload) => {
      findAppealMock.mockResolvedValue({
        ...ratingAppeal,
        content_type: type,
        payload
      })

      for (const approve of [true, false]) {
        executeRawMock.mockClear()
        claimAppealMock.mockClear()

        expect(await handleAppeal({ appealId: 1, approve }, 99)).toEqual({})

        expect(executeRawMock).toHaveBeenCalledTimes(1)
        const [template, contentId] = executeRawMock.mock.calls[0]
        expect(template.join('?')).toBe(
          `SELECT id FROM ${table} WHERE id = ? FOR UPDATE`
        )
        expect(contentId).toBe(5)
        expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
          claimAppealMock.mock.invocationCallOrder[0]
        )
      }
    }
  )
})

describe('handleAppeal approve rating', () => {
  // 评分统计的重算与详情缓存的失效都在迁移命令里, 随同一事务
  it('restores the hidden rating with the appealed summary through the transition command', async () => {
    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    // 只从隐藏 (2) 转公开 (0); 隐藏态的内容没有在途审核任务
    expect(transitionRatingsMock).toHaveBeenCalledWith(txContext, [5], {
      from: [2],
      to: 0,
      data: { short_summary: 'restored' },
      openTasks: 'keep'
    })
    // 以申诉行的认领为幂等闸门, 认领在前
    expect(claimAppealMock).toHaveBeenCalledWith({
      where: { id: 1, status: 'pending' },
      data: { status: 'approved', handled_by: 99 }
    })
    expect(claimAppealMock.mock.invocationCallOrder[0]).toBeLessThan(
      transitionRatingsMock.mock.invocationCallOrder[0]
    )
    expect(createMessageMock.mock.calls[0][0].content).toBe(
      APPEAL_RESULT_NOTICE.approved(MODERATION_CONTENT_TYPE_MAP.rating)
    )
    expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
    expect(createLogMock).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['transaction-start', 'transaction-commit'])
    expect(invalidateUnreadMock).toHaveBeenCalledWith(7)
  })

  it('returns an error and rolls back when the rating is no longer hidden', async () => {
    transitionRatingsMock.mockResolvedValue([])

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toBe(
      '内容已不存在或状态已变更, 无法通过, 可拒绝该申诉以关闭'
    )
    // 认领随回滚还原, 申诉保持待处理
    expect(events).toEqual(['transaction-start'])
    expect(createMessageMock).not.toHaveBeenCalled()
    expect(createLogMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })

  it('returns an error and touches nothing when the appeal was already handled', async () => {
    claimAppealMock.mockResolvedValue({ count: 0 })

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toBe('该申诉已被处理, 请刷新后重试')
    expect(transitionRatingsMock).not.toHaveBeenCalled()
    expect(createMessageMock).not.toHaveBeenCalled()
  })

  // 重试是兜底: 与别的事务互等、被数据库判死锁回滚时重放一遍
  it('replays the transaction when it loses a deadlock', async () => {
    transactionMock.mockRejectedValueOnce({
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: { kind: 'postgres', originalCode: '40P01' }
        }
      }
    })

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    expect(transactionMock).toHaveBeenCalledTimes(2)
    expect(transitionRatingsMock).toHaveBeenCalledTimes(1)
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

  // 评论恢复公开后的缓存失效与通知补发 (创建时被拦截而没发的) 由迁移命令登记
  it('writes the appealed text together with its rendered html and version', async () => {
    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    expect(renderForWriteMock).toHaveBeenCalledWith('comment', '改过的评论')
    expect(transitionCommentsMock).toHaveBeenCalledWith(txContext, [5], {
      from: [2],
      to: 0,
      data: {
        content: '改过的评论',
        content_html: '<p>ok</p>',
        content_html_version: 2,
        edit: expect.any(String)
      },
      openTasks: 'keep'
    })
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
    expect(transitionCommentsMock).not.toHaveBeenCalled()
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
    // 只从隐藏 (resource 为 1) 转公开, 连同申诉里的名称与介绍
    expect(transitionResourcesMock).toHaveBeenCalledWith(txContext, [5], {
      from: [1],
      to: 0,
      data: { name: '新标题', note: '新介绍' },
      openTasks: 'keep'
    })
    expect(renderForWriteMock).toHaveBeenCalledWith('note', '新介绍')
    // 链接行在迁移命令锁住资源行之后才读写, 与资源编辑的加锁顺序一致
    expect(transitionResourcesMock.mock.invocationCallOrder[0]).toBeLessThan(
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

  it('never writes the address or the size of an s3 link, whatever the payload carries', async () => {
    await handleAppeal({ appealId: 1, approve: true }, 99)

    // 站内存储的地址与大小由服务端按绑定的上传文件写下: 只写两个口令。大小还可改的时候
    // 提交、至今没处理的申诉, 载荷里改过的大小同样不写回
    expect(updateLinkMock).toHaveBeenCalledWith({
      where: { id: 21 },
      data: { code: '', password: 'pw-1' }
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
      data: { code: 'c0de', password: '' }
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

    // 管理员复核的内容对不上现有链接: 整体失败并回滚 (已做的恢复公开随之撤销),
    // 不部分套用, 不通知不记日志。拒绝申诉会删除仍隐藏的资源, 文案里带上不删资源的
    // 处理办法
    expect(result).toBe(
      '资源链接在申诉提交后已变更, 无法通过该申诉。如需保留该资源, 请先在下载资源管理中恢复它, 再拒绝本申诉'
    )
    expect(events).toEqual(['transaction-start'])
    expect(updateLinkMock).not.toHaveBeenCalled()
    expect(createMessageMock).not.toHaveBeenCalled()
    expect(createLogMock).not.toHaveBeenCalled()
  })

  it('writes the model name back only where the stored type is an AI patch', async () => {
    findAppealMock.mockResolvedValue({
      ...resourceAppeal,
      payload: { ...resourceAppeal.payload, modelName: 'DeepSeek-V3' }
    })

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    // 模型型号只属于 AI 翻译补丁: 以库中的类型为条件写, 不看载荷
    expect(updateResourceMock.mock.calls).toEqual([
      [
        {
          where: { id: 5, type: { has: 'ai' } },
          data: { model_name: 'DeepSeek-V3' }
        }
      ]
    ])
    // 先由迁移命令取得资源行锁并确认仍是隐藏态
    expect(transitionResourcesMock.mock.invocationCallOrder[0]).toBeLessThan(
      updateResourceMock.mock.invocationCallOrder[0]
    )
  })

  it('does not write the model name when the resource is no longer hidden', async () => {
    findAppealMock.mockResolvedValue({
      ...resourceAppeal,
      payload: { ...resourceAppeal.payload, modelName: 'DeepSeek-V3' }
    })
    transitionResourcesMock.mockResolvedValue([])

    await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(updateResourceMock).not.toHaveBeenCalled()
  })

  it('leaves link rows alone for an appeal submitted before links were editable', async () => {
    findAppealMock.mockResolvedValue({
      ...resourceAppeal,
      payload: { name: '新标题', note: '新介绍' }
    })

    const result = await handleAppeal({ appealId: 1, approve: true }, 99)

    expect(result).toEqual({})
    expect(updateResourceMock).not.toHaveBeenCalled()
    expect(txLinkFindManyMock).not.toHaveBeenCalled()
    expect(updateLinkMock).not.toHaveBeenCalled()
  })

  it('does not touch link rows when the resource is no longer hidden', async () => {
    transitionResourcesMock.mockResolvedValue([])

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
    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    // 守卫: 行锁下仍是隐藏态 (2) 才删 (R1)
    expect(planRatingRemovalMock).toHaveBeenCalledWith(txContext, [5], {
      statusIn: [2]
    })
    expect(executeRatingRemovalMock).toHaveBeenCalledWith(
      txContext,
      await planRatingRemovalMock.mock.results[0].value,
      { orphanReports: 'inline' }
    )
    // R3: 通知与审计随删除同事务 —— createMessage 收到 tx, admin_log 写在 tx 上
    expect(createMessageMock).toHaveBeenCalledTimes(1)
    expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
    expect(createMessageMock.mock.calls[0][0].content).toBe(
      APPEAL_RESULT_NOTICE.rejected(MODERATION_CONTENT_TYPE_MAP.rating)
    )
    expect(createLogMock).toHaveBeenCalledTimes(1)
    expect(executeRatingRemovalMock.mock.invocationCallOrder[0]).toBeLessThan(
      createMessageMock.mock.invocationCallOrder[0]
    )
    expect(invalidateUnreadMock).toHaveBeenCalledWith(7)
  })

  it('keeps a restored rating and sends the "kept" notice without deleting', async () => {
    // 行锁下读到已恢复 (status 0): 并发恢复赢得竞态, 不得删除 (R1); 内容保留,
    // 它的举报、任务、申诉都不清理
    planRatingRemovalMock.mockResolvedValue({
      rows: [],
      skipped: [{ id: 5, reason: 'status', status: 0 }]
    })

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    expect(executeRatingRemovalMock).not.toHaveBeenCalled()
    expect(createMessageMock.mock.calls[0][0].content).toBe(
      APPEAL_RESULT_NOTICE.rejectedKept(MODERATION_CONTENT_TYPE_MAP.rating)
    )
    expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
  })

  it('closes the appeal without side effects when the rating is already gone', async () => {
    // 内容已被并发删除: 达到拒绝目标, 关闭申诉但不重复删
    planRatingRemovalMock.mockResolvedValue({
      rows: [],
      skipped: [{ id: 5, reason: 'gone' }]
    })

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    expect(executeRatingRemovalMock).not.toHaveBeenCalled()
    expect(createMessageMock.mock.calls[0][0].content).toBe(
      APPEAL_RESULT_NOTICE.rejected(MODERATION_CONTENT_TYPE_MAP.rating)
    )
  })

  it('returns an error and touches nothing when the appeal was already handled', async () => {
    // 认领失败: 整体回滚, 不删不通知, 不留下孤儿 pending 申诉 (R2)
    claimAppealMock.mockResolvedValue({ count: 0 })

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toBe('该申诉已被处理, 请刷新后重试')
    expect(planRatingRemovalMock).not.toHaveBeenCalled()
    expect(createMessageMock).not.toHaveBeenCalled()
    expect(createLogMock).not.toHaveBeenCalled()
  })

  describe('resource', () => {
    beforeEach(() => {
      findAppealMock.mockResolvedValue({
        ...ratingAppeal,
        content_type: 'resource'
      })
    })

    // 删除连同资源评论区的站内信、任务、申诉与孤儿举报的清理, S3 与搜索出箱,
    // 缓存失效, 都在命令里 (此前这条路径不清评论派生物)
    it('deletes the resource through the removal command, guarded on the hidden status', async () => {
      const result = await handleAppeal({ appealId: 1, approve: false }, 99)

      expect(result).toEqual({})
      // 守卫: 行锁下仍是隐藏态 (resource 为 1) 才删; 收回发布奖励
      expect(planResourceRemovalMock).toHaveBeenCalledWith(txContext, [5], {
        guard: { statusIn: [1] },
        refundPublishReward: true
      })
      expect(executeResourceRemovalMock).toHaveBeenCalledWith(
        txContext,
        await planResourceRemovalMock.mock.results[0].value
      )
      expect(createMessageMock.mock.calls[0][0].content).toBe(
        APPEAL_RESULT_NOTICE.rejected(MODERATION_CONTENT_TYPE_MAP.resource)
      )
      expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
      expect(createLogMock.mock.calls[0][0].data.content).toContain(
        ', 内容已删除'
      )
    })

    it('does not delete a resource that was restored before the transaction', async () => {
      // 行锁下读到已恢复 (status 0): 并发恢复赢得竞态, 内容保留
      planResourceRemovalMock.mockResolvedValue({
        rows: [],
        skipped: [{ id: 5, reason: 'status', status: 0 }],
        refundPublishReward: false
      })

      const result = await handleAppeal({ appealId: 1, approve: false }, 99)

      expect(result).toEqual({})
      // 资源保留 → 其评论仍在, 什么都不清理
      expect(executeResourceRemovalMock).not.toHaveBeenCalled()
      expect(createMessageMock.mock.calls[0][0].content).toBe(
        APPEAL_RESULT_NOTICE.rejectedKept(MODERATION_CONTENT_TYPE_MAP.resource)
      )
    })

    it('closes the appeal when the resource is already gone', async () => {
      planResourceRemovalMock.mockResolvedValue({
        rows: [],
        skipped: [{ id: 5, reason: 'gone' }],
        refundPublishReward: false
      })

      const result = await handleAppeal({ appealId: 1, approve: false }, 99)

      expect(result).toEqual({})
      expect(executeResourceRemovalMock).not.toHaveBeenCalled()
      expect(createLogMock.mock.calls[0][0].data.content).toContain(
        ', 内容已被其他操作删除, 未重复执行'
      )
    })
  })

  describe('comment', () => {
    beforeEach(() => {
      findAppealMock.mockResolvedValue({
        ...ratingAppeal,
        content_type: 'comment'
      })
    })

    it('deletes the comment through the removal command, guarded on the hidden status', async () => {
      const result = await handleAppeal({ appealId: 1, approve: false }, 99)

      expect(result).toEqual({})
      // 守卫: 行锁下仍是隐藏态 (2) 才删
      expect(planCommentRemovalMock).toHaveBeenCalledWith(txContext, [5], {
        statusIn: [2]
      })
      expect(executeCommentRemovalMock).toHaveBeenCalledWith(
        txContext,
        await planCommentRemovalMock.mock.results[0].value,
        { orphanReports: 'inline' }
      )
      // 认领申诉在前, 通知与审计随删除同事务
      expect(claimAppealMock.mock.invocationCallOrder[0]).toBeLessThan(
        planCommentRemovalMock.mock.invocationCallOrder[0]
      )
      expect(createMessageMock.mock.calls[0][0].content).toBe(
        APPEAL_RESULT_NOTICE.rejected(MODERATION_CONTENT_TYPE_MAP.comment)
      )
      expect(createMessageMock.mock.calls[0][1]).toBe(transactionClient)
      expect(createLogMock.mock.calls[0][0].data.content).toContain(
        ', 内容已删除'
      )
    })

    it('keeps a restored comment: nothing is removed and the "kept" notice is sent', async () => {
      // 行锁下读到已恢复 (status 0): 并发恢复赢得竞态, 内容连同它的通知、任务、申诉都保留
      planCommentRemovalMock.mockResolvedValue({
        roots: [],
        skipped: [{ id: 5, reason: 'status', status: 0 }],
        subtree: []
      })

      const result = await handleAppeal({ appealId: 1, approve: false }, 99)

      expect(result).toEqual({})
      expect(executeCommentRemovalMock).not.toHaveBeenCalled()
      expect(createMessageMock.mock.calls[0][0].content).toBe(
        APPEAL_RESULT_NOTICE.rejectedKept(MODERATION_CONTENT_TYPE_MAP.comment)
      )
      expect(createLogMock.mock.calls[0][0].data.content).toContain(
        ', 内容已被其他操作恢复, 未执行删除'
      )
    })

    it('closes the appeal when the comment is already gone', async () => {
      planCommentRemovalMock.mockResolvedValue({
        roots: [],
        skipped: [{ id: 5, reason: 'gone' }],
        subtree: []
      })

      const result = await handleAppeal({ appealId: 1, approve: false }, 99)

      expect(result).toEqual({})
      expect(executeCommentRemovalMock).not.toHaveBeenCalled()
      expect(createMessageMock.mock.calls[0][0].content).toBe(
        APPEAL_RESULT_NOTICE.rejected(MODERATION_CONTENT_TYPE_MAP.comment)
      )
      expect(createLogMock.mock.calls[0][0].data.content).toContain(
        ', 内容已被其他操作删除, 未重复执行'
      )
    })

    it('does not touch the comment when the appeal was already handled', async () => {
      claimAppealMock.mockResolvedValue({ count: 0 })

      const result = await handleAppeal({ appealId: 1, approve: false }, 99)

      expect(result).toBe('该申诉已被处理, 请刷新后重试')
      expect(planCommentRemovalMock).not.toHaveBeenCalled()
      expect(createMessageMock).not.toHaveBeenCalled()
    })
  })

  // 与并发的取消隐藏 / 审核裁决在行锁上互等时, 数据库会判死锁回滚其中一方
  it('replays the transaction when it loses a deadlock', async () => {
    transactionMock.mockRejectedValueOnce({
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: { kind: 'postgres', originalCode: '40P01' }
        }
      }
    })

    const result = await handleAppeal({ appealId: 1, approve: false }, 99)

    expect(result).toEqual({})
    expect(transactionMock).toHaveBeenCalledTimes(2)
    expect(executeRatingRemovalMock).toHaveBeenCalledTimes(1)
  })
})
