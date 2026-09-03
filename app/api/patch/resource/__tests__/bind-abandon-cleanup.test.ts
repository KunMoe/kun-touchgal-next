import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  patchFindUniqueMock,
  resourceFindUniqueMock,
  resourceCountMock,
  transactionMock,
  transactionResourceCreateMock,
  transactionResourceUpdateMock,
  transactionUserUpdateMock,
  transactionPatchUpdateMock,
  transactionQueryRawMock,
  transactionLinkFindManyMock,
  bindUploadedResourceMock,
  enqueueResourceLinkDeletionsMock,
  abandonBoundResourceObjectsMock,
  recalcPatchTypeMock,
  enqueueSearchOutboxMock,
  queueSearchSyncMock,
  preScreenTextMock,
  hasPendingModerationMock,
  createModerationTaskMock,
  invalidatePatchResourceDetailCacheMock,
  invalidateResourceListCacheMock,
  invalidatePatchContentCacheMock,
  invalidateUserSessionMock,
  invalidateUserPendingResourceCacheMock,
  createMessageMock,
  kickS3DeletionDrainMock,
  markdownToHtmlMock
} = vi.hoisted(() => ({
  patchFindUniqueMock: vi.fn(),
  resourceFindUniqueMock: vi.fn(),
  resourceCountMock: vi.fn(),
  transactionMock: vi.fn(),
  transactionResourceCreateMock: vi.fn(),
  transactionResourceUpdateMock: vi.fn(),
  transactionUserUpdateMock: vi.fn(),
  transactionPatchUpdateMock: vi.fn(),
  transactionQueryRawMock: vi.fn(),
  transactionLinkFindManyMock: vi.fn(),
  bindUploadedResourceMock: vi.fn(),
  enqueueResourceLinkDeletionsMock: vi.fn(),
  abandonBoundResourceObjectsMock: vi.fn(),
  recalcPatchTypeMock: vi.fn(),
  enqueueSearchOutboxMock: vi.fn(),
  queueSearchSyncMock: vi.fn(),
  preScreenTextMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  createModerationTaskMock: vi.fn(),
  invalidatePatchResourceDetailCacheMock: vi.fn(),
  invalidateResourceListCacheMock: vi.fn(),
  invalidatePatchContentCacheMock: vi.fn(),
  invalidateUserSessionMock: vi.fn(),
  invalidateUserPendingResourceCacheMock: vi.fn(),
  createMessageMock: vi.fn(),
  kickS3DeletionDrainMock: vi.fn(),
  markdownToHtmlMock: vi.fn()
}))

const transactionClient = {
  patch_resource: {
    create: transactionResourceCreateMock,
    update: transactionResourceUpdateMock
  },
  patch_resource_link: { findMany: transactionLinkFindManyMock },
  user: { update: transactionUserUpdateMock },
  patch: { update: transactionPatchUpdateMock },
  $queryRaw: transactionQueryRawMock
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findUnique: patchFindUniqueMock },
    patch_resource: {
      findUnique: resourceFindUniqueMock,
      count: resourceCountMock
    },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  abandonBoundResourceObjects: abandonBoundResourceObjectsMock,
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

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: invalidateUserSessionMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: vi.fn()
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: invalidateUserPendingResourceCacheMock
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueSearchOutboxMock,
  queueSearchSync: queueSearchSyncMock
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: kickS3DeletionDrainMock
}))

vi.mock('~/server/moderation/submit', () => ({
  MODERATION_SKIP: { intercept: false, queue: false, dryRun: false },
  createModerationTask: createModerationTaskMock,
  hasPendingModeration: hasPendingModerationMock,
  preScreenText: preScreenTextMock
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

vi.mock('~/app/api/utils/render/markdownToHtml', () => ({
  markdownToHtml: markdownToHtmlMock
}))

import { createPatchResource } from '~/app/api/patch/resource/create'
import { updatePatchResource } from '~/app/api/patch/resource/update'

const s3Link = (hash: string, overrides: Record<string, unknown> = {}) => ({
  storage: 's3',
  hash,
  content: '',
  size: '100MB',
  code: '',
  password: '',
  ...overrides
})

const buildUpdateInput = (overrides: Record<string, unknown> = {}) => ({
  resourceId: 1,
  patchId: 10,
  section: 'galgame',
  name: 'New name',
  note: '',
  links: [],
  type: ['manual'],
  language: ['zh-Hans'],
  platform: ['windows'],
  emulatorType: [],
  modelName: '',
  ...overrides
})

const buildCreateInput = (overrides: Record<string, unknown> = {}) => ({
  patchId: 10,
  section: 'galgame',
  name: 'Res',
  note: '',
  links: [],
  type: ['manual'],
  language: ['zh-Hans'],
  platform: ['windows'],
  emulatorType: [],
  modelName: '',
  ...overrides
})

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

const buildRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  status: 0,
  section: 'galgame',
  user_id: 7,
  patch_id: 10,
  name: 'Res',
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

const BOUND_A = { downloadLink: 'c-a', s3Key: 'k-a', size: 1 }

beforeEach(() => {
  vi.resetAllMocks()
  patchFindUniqueMock.mockResolvedValue({
    id: 10,
    unique_id: 'kun-10',
    name: 'Patch'
  })
  resourceCountMock.mockResolvedValue(1)
  hasPendingModerationMock.mockResolvedValue(false)
  preScreenTextMock.mockResolvedValue({
    intercept: false,
    queue: false,
    dryRun: false
  })
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
  recalcPatchTypeMock.mockResolvedValue('kun-10')
  markdownToHtmlMock.mockResolvedValue('')
  transactionQueryRawMock.mockResolvedValue([{ status: 0, section: 'galgame' }])
  transactionLinkFindManyMock.mockResolvedValue([])
})

// 一次成功的 bind 已复制对象到随机段 finalKey 且删除 staging/token: 任何未落库
// 即返回的路径若不清理, 该对象无 DB 引用、无法重绑、无法重建 → 永久孤儿
describe('更新资源阶段一早退时清理已重绑对象', () => {
  it('后续链接 bind 失败时, 先清理已重绑对象再返回错误', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    bindUploadedResourceMock
      .mockResolvedValueOnce(BOUND_A)
      .mockResolvedValueOnce('您今日的上传大小已达到 5GB 限额')

    const input = buildUpdateInput({
      links: [s3Link('token-a'), s3Link('token-b')]
    })
    const result = await updatePatchResource(input, 7, 1)

    expect(result).toBe('您今日的上传大小已达到 5GB 限额')
    expect(abandonBoundResourceObjectsMock).toHaveBeenCalledWith(
      [{ content: 'c-a', s3Key: 'k-a' }],
      10
    )
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('后续链接 bind 抛错时, 先清理已重绑对象再原样抛出', async () => {
    // 抛错迭代自身在 _helper 内自清, 循环级 catch 只需清理历史条目
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    bindUploadedResourceMock
      .mockResolvedValueOnce(BOUND_A)
      .mockRejectedValueOnce(new Error('copy timeout'))

    const input = buildUpdateInput({
      links: [s3Link('token-a'), s3Link('token-b')]
    })
    await expect(updatePatchResource(input, 7, 1)).rejects.toThrow(
      'copy timeout'
    )

    expect(abandonBoundResourceObjectsMock).toHaveBeenCalledWith(
      [{ content: 'c-a', s3Key: 'k-a' }],
      10
    )
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('保留型链接资格预检失败时, 同样清理已重绑对象', async () => {
    // 快照 links 为空: id=5 的保留型链接找不到对应行, 预检失败
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    bindUploadedResourceMock.mockResolvedValueOnce(BOUND_A)

    const input = buildUpdateInput({
      links: [s3Link('token-a'), s3Link('', { id: 5, content: 'old-c' })]
    })
    const result = await updatePatchResource(input, 7, 1)

    expect(result).toBe('请先上传资源文件')
    expect(abandonBoundResourceObjectsMock).toHaveBeenCalledWith(
      [{ content: 'c-a', s3Key: 'k-a' }],
      10
    )
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('事务抛错回滚时, 兜底清理后原样抛出', async () => {
    // 回滚连带撤销冲突分支的事务内入队, 必须在事务外兜底
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    bindUploadedResourceMock.mockResolvedValueOnce(BOUND_A)
    transactionMock.mockRejectedValue(new Error('db down'))

    const input = buildUpdateInput({ links: [s3Link('token-a')] })
    await expect(updatePatchResource(input, 7, 1)).rejects.toThrow('db down')

    expect(abandonBoundResourceObjectsMock).toHaveBeenCalledWith(
      [{ content: 'c-a', s3Key: 'k-a' }],
      10
    )
  })

  it('预筛在 S3 绑定之前完成, 预筛故障时尚无已绑对象可泄漏', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    bindUploadedResourceMock.mockResolvedValueOnce(BOUND_A)
    preScreenTextMock.mockRejectedValue(new Error('redis down'))

    const input = buildUpdateInput({ links: [s3Link('token-a')] })
    await expect(updatePatchResource(input, 7, 1)).rejects.toThrow('redis down')

    expect(bindUploadedResourceMock).not.toHaveBeenCalled()
  })

  it('绑定与事务全部成功时不触发清理', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    bindUploadedResourceMock.mockResolvedValueOnce(BOUND_A)
    transactionMock.mockImplementation(
      async (callback: (client: typeof transactionClient) => unknown) =>
        callback(transactionClient)
    )
    transactionResourceUpdateMock.mockResolvedValue(buildRow())

    const input = buildUpdateInput({ links: [s3Link('token-a')] })
    const result = await updatePatchResource(input, 7, 1)

    expect(typeof result).not.toBe('string')
    expect(abandonBoundResourceObjectsMock).not.toHaveBeenCalled()
  })
})

describe('创建资源循环早退时清理已绑定对象', () => {
  it('后续链接 bind 失败时, 先清理已绑定对象再返回错误', async () => {
    bindUploadedResourceMock
      .mockResolvedValueOnce(BOUND_A)
      .mockResolvedValueOnce('上传 token 已过期或不存在, 请重新上传文件')

    const input = buildCreateInput({
      links: [s3Link('token-a'), s3Link('token-b')]
    })
    const result = await createPatchResource(input, 7, 1)

    expect(result).toBe('上传 token 已过期或不存在, 请重新上传文件')
    expect(abandonBoundResourceObjectsMock).toHaveBeenCalledWith(
      [{ content: 'c-a', s3Key: 'k-a' }],
      10
    )
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('后续链接 bind 抛错时, 先清理已绑定对象再原样抛出', async () => {
    bindUploadedResourceMock
      .mockResolvedValueOnce(BOUND_A)
      .mockRejectedValueOnce(new Error('copy timeout'))

    const input = buildCreateInput({
      links: [s3Link('token-a'), s3Link('token-b')]
    })
    await expect(createPatchResource(input, 7, 1)).rejects.toThrow(
      'copy timeout'
    )

    expect(abandonBoundResourceObjectsMock).toHaveBeenCalledWith(
      [{ content: 'c-a', s3Key: 'k-a' }],
      10
    )
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('后续链接 hash 为空时, 同样清理已绑定对象', async () => {
    bindUploadedResourceMock.mockResolvedValueOnce(BOUND_A)

    const input = buildCreateInput({
      links: [s3Link('token-a'), s3Link('')]
    })
    const result = await createPatchResource(input, 7, 1)

    expect(result).toBe('请先上传资源文件')
    expect(abandonBoundResourceObjectsMock).toHaveBeenCalledWith(
      [{ content: 'c-a', s3Key: 'k-a' }],
      10
    )
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('事务抛错回滚时, 兜底清理后原样抛出', async () => {
    bindUploadedResourceMock.mockResolvedValueOnce(BOUND_A)
    transactionMock.mockRejectedValue(new Error('db down'))

    const input = buildCreateInput({ links: [s3Link('token-a')] })
    await expect(createPatchResource(input, 7, 1)).rejects.toThrow('db down')

    expect(abandonBoundResourceObjectsMock).toHaveBeenCalledWith(
      [{ content: 'c-a', s3Key: 'k-a' }],
      10
    )
  })

  it('绑定与事务全部成功时不触发清理', async () => {
    bindUploadedResourceMock.mockResolvedValueOnce(BOUND_A)
    transactionMock.mockImplementation(
      async (callback: (client: typeof transactionClient) => unknown) =>
        callback(transactionClient)
    )
    transactionResourceCreateMock.mockResolvedValue(buildRow({ id: 2 }))

    const input = buildCreateInput({ links: [s3Link('token-a')] })
    const result = await createPatchResource(input, 7, 1)

    expect(typeof result).not.toBe('string')
    expect(abandonBoundResourceObjectsMock).not.toHaveBeenCalled()
  })
})
