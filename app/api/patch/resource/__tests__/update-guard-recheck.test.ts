import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  resourceFindUniqueMock,
  patchFindUniqueMock,
  transactionMock,
  transactionQueryRawMock,
  transactionLinkFindManyMock,
  transactionResourceUpdateMock,
  transactionPatchUpdateMock,
  bindUploadedResourceMock,
  enqueueResourceLinkDeletionsMock,
  recalcPatchTypeMock,
  enqueueTextModerationMock,
  hasPendingModerationMock,
  planTextModerationMock,
  enqueueSearchOutboxMock,
  queueSearchSyncMock,
  invalidatePatchResourceDetailCacheMock,
  invalidateResourceListCacheMock,
  invalidatePatchContentCacheMock,
  invalidateUserPendingResourceCacheMock,
  kickS3DeletionDrainMock
} = vi.hoisted(() => ({
  resourceFindUniqueMock: vi.fn(),
  patchFindUniqueMock: vi.fn(),
  transactionMock: vi.fn(),
  transactionQueryRawMock: vi.fn(),
  transactionLinkFindManyMock: vi.fn(),
  transactionResourceUpdateMock: vi.fn(),
  transactionPatchUpdateMock: vi.fn(),
  bindUploadedResourceMock: vi.fn(),
  enqueueResourceLinkDeletionsMock: vi.fn(),
  recalcPatchTypeMock: vi.fn(),
  enqueueTextModerationMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  planTextModerationMock: vi.fn(),
  enqueueSearchOutboxMock: vi.fn(),
  queueSearchSyncMock: vi.fn(),
  invalidatePatchResourceDetailCacheMock: vi.fn(),
  invalidateResourceListCacheMock: vi.fn(),
  invalidatePatchContentCacheMock: vi.fn(),
  invalidateUserPendingResourceCacheMock: vi.fn(),
  kickS3DeletionDrainMock: vi.fn()
}))

const transactionClient = {
  patch_resource: { update: transactionResourceUpdateMock },
  patch_resource_link: { findMany: transactionLinkFindManyMock },
  patch: { update: transactionPatchUpdateMock },
  $queryRaw: transactionQueryRawMock
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch_resource: { findUnique: resourceFindUniqueMock },
    patch: { findUnique: patchFindUniqueMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  bindUploadedResource: bindUploadedResourceMock,
  enqueueResourceLinkDeletions: enqueueResourceLinkDeletionsMock,
  recalcPatchType: recalcPatchTypeMock
}))

vi.mock('~/app/api/patch/resource/cache', () => ({
  invalidatePatchResourceDetailCache: invalidatePatchResourceDetailCacheMock
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: invalidateResourceListCacheMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidatePatchContentCacheMock
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: invalidateUserPendingResourceCacheMock
}))

vi.mock('~/server/moderation/submit', () => ({
  MODERATION_SKIP: { queue: false, intercept: false, dryRun: false },
  enqueueTextModeration: enqueueTextModerationMock,
  hasPendingModeration: hasPendingModerationMock,
  planTextModeration: planTextModerationMock
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueSearchOutboxMock,
  queueSearchSync: queueSearchSyncMock
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: kickS3DeletionDrainMock
}))

import {
  frontResourceEditGuard,
  updatePatchResource
} from '~/app/api/patch/resource/update'

// 按前台入口的方式调用: 操作者, 加前台入口为它算出的守卫
const updateResource = (
  input: Parameters<typeof updatePatchResource>[0],
  uid: number,
  role: number
) =>
  updatePatchResource(
    input,
    { uid, role },
    frontResourceEditGuard({ uid, role })
  )

const buildInput = (overrides: Record<string, unknown> = {}) => ({
  resourceId: 1,
  patchId: 10,
  section: 'galgame',
  name: 'New name',
  note: '',
  links: [
    {
      storage: 'user',
      hash: '',
      content: 'https://example.com',
      size: '100MB',
      code: '',
      password: ''
    }
  ],
  type: ['manual'],
  language: ['zh-Hans'],
  platform: ['windows'],
  emulatorType: [],
  modelName: '',
  ...overrides
})

// 事务外预取的快照: 守卫初检与 S3 链接收集用它, 复检场景中恒为公开态
const buildSnapshot = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  status: 0,
  section: 'galgame',
  user_id: 7,
  patch_id: 10,
  name: 'Old name',
  note: '',
  model_name: '',
  links: [],
  ...overrides
})

const buildUpdated = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  status: 0,
  section: 'galgame',
  user_id: 7,
  patch_id: 10,
  name: 'New name',
  note: '',
  model_name: '',
  emulator_type: [],
  type: ['manual'],
  language: ['zh-Hans'],
  platform: ['windows'],
  download: 0,
  created: new Date('2026-01-01'),
  user: {
    id: 7,
    name: 'User',
    avatar: '',
    role: 1,
    _count: { patch_resource: 1 }
  },
  patch: { unique_id: 'kun-10' },
  links: [],
  ...overrides
})

const INTERCEPT = { queue: true, intercept: true, dryRun: false }

const expectNoWriteNoSideEffects = () => {
  expect(transactionResourceUpdateMock).not.toHaveBeenCalled()
  expect(enqueueTextModerationMock).not.toHaveBeenCalled()
  expect(recalcPatchTypeMock).not.toHaveBeenCalled()
  expect(enqueueSearchOutboxMock).not.toHaveBeenCalled()
  expect(queueSearchSyncMock).not.toHaveBeenCalled()
  expect(invalidatePatchContentCacheMock).not.toHaveBeenCalled()
  expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
  expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  expect(invalidateUserPendingResourceCacheMock).not.toHaveBeenCalled()
  expect(kickS3DeletionDrainMock).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  patchFindUniqueMock.mockResolvedValue({ id: 10 })
  transactionLinkFindManyMock.mockResolvedValue([])
  hasPendingModerationMock.mockResolvedValue(false)
  planTextModerationMock.mockResolvedValue(INTERCEPT)
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
  recalcPatchTypeMock.mockResolvedValue('patch-10')
  transactionMock.mockImplementation(
    async (callback: (client: typeof transactionClient) => unknown) =>
      callback(transactionClient)
  )
})

// 事务外守卫读的是快照, 与事务开始之间隔着 S3 绑定/预筛的秒级窗口;
// 锁下复检封死该窗口, 否则并发的管理员隐藏 (0→1) 会被预筛拦截写回
// 待审核 (3), AI 放行 (3→0) 即静默撤销管理员隐藏
describe('更新资源在行锁下复检守卫', () => {
  it('快照公开但锁下已被管理员隐藏, 拒绝写入', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([
      { status: 1, section: 'galgame' }
    ])

    const result = await updateResource(buildInput(), 7, 1)

    expect(result).toBe('未找到该资源')
    expectNoWriteNoSideEffects()
  })

  it('隐藏复检对管理员同样生效', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([
      { status: 1, section: 'galgame' }
    ])

    const result = await updateResource(buildInput(), 9, 3)

    expect(result).toBe('未找到该资源')
    expect(transactionResourceUpdateMock).not.toHaveBeenCalled()
  })

  it('快照公开但锁下已转待审核, 非特权作者被拒', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([
      { status: 3, section: 'galgame' }
    ])

    const result = await updateResource(buildInput(), 7, 1)

    expect(result).toBe('您发布的资源正在审核中, 暂时无法修改')
    expectNoWriteNoSideEffects()
  })

  it('锁下待审核不拦管理员, 保持事务外守卫语义', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([
      { status: 3, section: 'galgame' }
    ])
    transactionResourceUpdateMock.mockResolvedValue(buildUpdated({ status: 3 }))

    const result = await updateResource(buildInput(), 9, 3)

    expect(typeof result).not.toBe('string')
    // 内容写入照常发生 (这个文件里预筛默认拦截, 其后还有一条转待审核的写入)
    expect(transactionResourceUpdateMock.mock.calls[0][0].data).toHaveProperty(
      'links'
    )
  })

  it('快照公开但锁下已转人工审批, 非特权作者被拒', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([
      { status: 2, section: 'galgame' }
    ])

    const result = await updateResource(buildInput(), 7, 1)

    expect(result).toBe('您发布的资源正在等待管理员审核, 暂时无法修改')
    expectNoWriteNoSideEffects()
  })

  it('行在窗口期被删除时返回业务错误而非抛 P2025', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([])

    const result = await updateResource(buildInput(), 7, 1)

    expect(result).toBe('未找到该资源')
    expectNoWriteNoSideEffects()
  })

  // 复检拦截时 bind 已完成 (对象复制到 finalKey, staging 与 token 已删):
  // return 字符串会提交事务且不走 .catch 的 abandon 兜底, 已重绑对象
  // 必须随本事务入队清理, 否则成无 DB 引用的永久公开孤儿
  it('复检拦截时已重绑的 s3 对象随本事务入队清理', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([
      { status: 1, section: 'galgame' }
    ])
    bindUploadedResourceMock.mockResolvedValue({
      downloadLink: 'new-c',
      s3Key: 'new-k',
      size: 1
    })

    const input = buildInput({
      links: [
        {
          storage: 's3',
          hash: 'upload-token',
          content: '',
          size: '100MB',
          code: '',
          password: ''
        }
      ]
    })
    const result = await updateResource(input, 7, 1)

    expect(result).toBe('未找到该资源')
    expect(transactionResourceUpdateMock).not.toHaveBeenCalled()
    expect(enqueueResourceLinkDeletionsMock).toHaveBeenCalledWith(
      transactionClient,
      [{ content: 'new-c', patchId: 10, hash: '', s3Key: 'new-k' }]
    )
  })

  it('待审核复检拦截同样入队清理已重绑对象', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([
      { status: 3, section: 'galgame' }
    ])
    bindUploadedResourceMock.mockResolvedValue({
      downloadLink: 'new-c',
      s3Key: 'new-k',
      size: 1
    })

    const input = buildInput({
      links: [
        {
          storage: 's3',
          hash: 'upload-token',
          content: '',
          size: '100MB',
          code: '',
          password: ''
        }
      ]
    })
    const result = await updateResource(input, 7, 1)

    expect(result).toBe('您发布的资源正在审核中, 暂时无法修改')
    expect(transactionResourceUpdateMock).not.toHaveBeenCalled()
    expect(enqueueResourceLinkDeletionsMock).toHaveBeenCalledWith(
      transactionClient,
      [{ content: 'new-c', patchId: 10, hash: '', s3Key: 'new-k' }]
    )
  })
})

// links diff 的事实源是行锁下重读的集合: 事务外快照与行锁之间的并发编辑是
// deleteMany + create 整体换行, 基于快照的 diff 会漏删并发重绑的新 s3 对象、
// 并把已入队删除的旧 key 复制回新行成悬空链接
describe('更新资源在行锁下重算 links diff', () => {
  it('S3 删除入队取锁下集合, 并发换行也被入队', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([
      { status: 0, section: 'galgame' }
    ])
    // 并发编辑在快照后创建的行: 不在保留集合里, 即将随 deleteMany 一并消失
    transactionLinkFindManyMock.mockResolvedValue([
      { id: 91, storage: 's3', content: 'cc', hash: 'hh', s3_key: 'kk' }
    ])
    transactionResourceUpdateMock.mockResolvedValue(buildUpdated())

    const result = await updateResource(buildInput(), 7, 1)

    expect(typeof result).not.toBe('string')
    expect(enqueueResourceLinkDeletionsMock).toHaveBeenCalledWith(
      transactionClient,
      [{ content: 'cc', patchId: 10, hash: 'hh', s3Key: 'kk' }]
    )
  })

  it('保留型 s3 链接锁下已被并发重建, 返回冲突并清理本次重绑对象', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      buildSnapshot({
        links: [
          {
            id: 5,
            storage: 's3',
            content: 'old-c',
            hash: '',
            s3_key: 'old-k',
            size: '100MB',
            code: '',
            password: ''
          }
        ]
      })
    )
    transactionQueryRawMock.mockResolvedValue([
      { status: 0, section: 'galgame' }
    ])
    // 锁下集合已无 id=5: 并发编辑已 deleteMany + create 整体换行
    transactionLinkFindManyMock.mockResolvedValue([])
    bindUploadedResourceMock.mockResolvedValue({
      downloadLink: 'new-c',
      s3Key: 'new-k',
      size: 1
    })

    const input = buildInput({
      links: [
        {
          storage: 's3',
          hash: 'upload-token',
          content: '',
          size: '100MB',
          code: '',
          password: ''
        },
        {
          id: 5,
          storage: 's3',
          hash: '',
          content: 'old-c',
          size: '100MB',
          code: '',
          password: ''
        }
      ]
    })
    const result = await updateResource(input, 7, 1)

    expect(result).toBe('该资源的链接已被修改, 请刷新后重试')
    expect(transactionResourceUpdateMock).not.toHaveBeenCalled()
    // 本次已重绑的新对象随本事务入队清理, 不留公开可达的孤儿
    expect(enqueueResourceLinkDeletionsMock).toHaveBeenCalledWith(
      transactionClient,
      [{ content: 'new-c', patchId: 10, hash: '', s3Key: 'new-k' }]
    )
  })
})

// 预签名直传迁移前的历史 s3 链接: hash 列存 BLAKE3 校验码、s3_key 为空,
// 对象 key 靠 hash 还原. 编辑表单原样回传该 hash, 不能被当成上传 token
describe('更新资源保留历史 s3 链接', () => {
  const legacyLink = {
    id: 5,
    storage: 's3',
    content: 'legacy-c',
    hash: 'blake3-hash',
    s3_key: '',
    size: '100MB',
    code: '',
    password: ''
  }
  const legacyInputLink = {
    id: 5,
    storage: 's3',
    hash: 'blake3-hash',
    content: 'legacy-c',
    size: '100MB',
    code: '',
    password: ''
  }

  beforeEach(() => {
    resourceFindUniqueMock.mockResolvedValue(
      buildSnapshot({ links: [legacyLink] })
    )
    transactionQueryRawMock.mockResolvedValue([
      { status: 0, section: 'galgame' }
    ])
    transactionLinkFindManyMock.mockResolvedValue([legacyLink])
    transactionResourceUpdateMock.mockResolvedValue(buildUpdated())
  })

  it('回传库中原 hash 视为保留, 不走上传绑定且原样保留 hash', async () => {
    const result = await updateResource(
      buildInput({ links: [legacyInputLink] }),
      7,
      1
    )

    expect(typeof result).not.toBe('string')
    expect(bindUploadedResourceMock).not.toHaveBeenCalled()
    const created =
      transactionResourceUpdateMock.mock.calls[0][0].data.links.create
    expect(created).toEqual([
      expect.objectContaining({
        storage: 's3',
        content: 'legacy-c',
        hash: 'blake3-hash',
        s3_key: ''
      })
    ])
    expect(enqueueResourceLinkDeletionsMock).toHaveBeenCalledWith(
      transactionClient,
      []
    )
  })

  it('历史链接换新文件时按 token 绑定, 旧对象按原 hash 入队删除', async () => {
    bindUploadedResourceMock.mockResolvedValue({
      downloadLink: 'new-c',
      s3Key: 'new-k',
      size: 1
    })

    const result = await updateResource(
      buildInput({ links: [{ ...legacyInputLink, hash: 'upload-token' }] }),
      7,
      1
    )

    expect(typeof result).not.toBe('string')
    expect(bindUploadedResourceMock).toHaveBeenCalledWith(10, 'upload-token', 7)
    const created =
      transactionResourceUpdateMock.mock.calls[0][0].data.links.create
    expect(created).toEqual([
      expect.objectContaining({ content: 'new-c', hash: '', s3_key: 'new-k' })
    ])
    expect(enqueueResourceLinkDeletionsMock).toHaveBeenCalledWith(
      transactionClient,
      [{ content: 'legacy-c', patchId: 10, hash: 'blake3-hash', s3Key: '' }]
    )
  })
})
