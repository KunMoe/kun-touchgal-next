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
  createModerationTaskMock,
  hasPendingModerationMock,
  preScreenTextMock,
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
  createModerationTaskMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  preScreenTextMock: vi.fn(),
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
  createModerationTask: createModerationTaskMock,
  hasPendingModeration: hasPendingModerationMock,
  preScreenText: preScreenTextMock
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: enqueueSearchOutboxMock,
  queueSearchSync: queueSearchSyncMock
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: kickS3DeletionDrainMock
}))

import { updatePatchResource } from '~/app/api/patch/resource/update'

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

// 事务外预取的快照, 权限判定与 S3 链接收集用它
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

// 事务内 update 的返回值, 即该行被覆写后的真实状态
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

beforeEach(() => {
  vi.resetAllMocks()
  transactionLinkFindManyMock.mockResolvedValue([])
  patchFindUniqueMock.mockResolvedValue({ id: 10 })
  hasPendingModerationMock.mockResolvedValue(false)
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
  recalcPatchTypeMock.mockResolvedValue('patch-10')
  transactionQueryRawMock.mockResolvedValue([{ status: 0, section: 'galgame' }])
  transactionMock.mockImplementation(
    async (callback: (client: typeof transactionClient) => unknown) =>
      callback(transactionClient)
  )
})

// 闸门读事务内行锁读到的 update 前状态而非事务外快照:
// 两者之间存在并发 approve (2→0) / AI 审核放行 (3→0) / 隐藏 (0→1) 的窗口
describe('更新资源按 update 前的行锁状态分派缓存失效', () => {
  // 快照 status=3, 并发 AI 审核放行后该行已是 0, 编辑的预筛拦截又写回 3:
  // 用快照判定 wasPublic=false 且 isPublic=false, 三个失效全部漏掉
  it('快照为待审核但 update 前已被放行, 编辑拦截后三个缓存全部失效', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      buildSnapshot({ status: 3, section: 'patch' })
    )
    transactionQueryRawMock.mockResolvedValue([{ status: 0, section: 'patch' }])
    preScreenTextMock.mockResolvedValue(INTERCEPT)
    transactionResourceUpdateMock.mockResolvedValue(
      buildUpdated({ status: 3, section: 'patch' })
    )

    await updatePatchResource(buildInput({ section: 'patch' }), 9, 3)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateResourceListCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserPendingResourceCacheMock).toHaveBeenCalledWith(7)
  })

  // 反向: 快照 status=0, 并发隐藏后该行已是 1, 锁下复检拒绝写入
  it('快照为公开但 update 前已被隐藏, 拒绝写入且不失效', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    transactionQueryRawMock.mockResolvedValue([
      { status: 1, section: 'galgame' }
    ])

    // name/note/model 均未变更 → 不送审, 不触发拦截
    const result = await updatePatchResource(
      buildInput({ name: 'Old name' }),
      9,
      3
    )

    expect(result).toBe('未找到该资源')
    expect(preScreenTextMock).not.toHaveBeenCalled()
    expect(transactionResourceUpdateMock).not.toHaveBeenCalled()
    expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  })

  it('公开资源正常编辑保持失效行为', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      buildSnapshot({ section: 'patch' })
    )
    transactionQueryRawMock.mockResolvedValue([{ status: 0, section: 'patch' }])
    preScreenTextMock.mockResolvedValue({
      queue: true,
      intercept: false,
      dryRun: true
    })
    transactionResourceUpdateMock.mockResolvedValue(
      buildUpdated({ section: 'patch' })
    )

    await updatePatchResource(buildInput({ section: 'patch' }), 7, 1)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateResourceListCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserPendingResourceCacheMock).not.toHaveBeenCalled()
  })

  it('无并发时编辑待审资源被拦截, 不触发公开缓存与 pending 失效', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot({ status: 3 }))
    transactionQueryRawMock.mockResolvedValue([
      { status: 3, section: 'galgame' }
    ])
    preScreenTextMock.mockResolvedValue(INTERCEPT)
    transactionResourceUpdateMock.mockResolvedValue(buildUpdated({ status: 3 }))

    await updatePatchResource(buildInput(), 9, 3)

    expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
    expect(invalidateUserPendingResourceCacheMock).not.toHaveBeenCalled()
  })

  it('公开资源被拦截转待审, 失效详情缓存与 pending 缓存', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    preScreenTextMock.mockResolvedValue(INTERCEPT)
    transactionResourceUpdateMock.mockResolvedValue(buildUpdated({ status: 3 }))

    await updatePatchResource(buildInput(), 7, 1)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
    expect(invalidateUserPendingResourceCacheMock).toHaveBeenCalledWith(7)
  })
})
