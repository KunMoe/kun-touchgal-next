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
  moderationSkip
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
  moderationSkip: { intercept: false, queue: false, dryRun: false }
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
  MODERATION_SKIP: moderationSkip,
  createModerationTask: createModerationTaskMock,
  hasPendingModeration: hasPendingModerationMock,
  preScreenText: preScreenTextMock
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

vi.mock('~/app/api/utils/render/markdownToHtml', () => ({
  markdownToHtml: vi.fn().mockResolvedValue('<p>Note</p>')
}))

import { createPatchResource } from '~/app/api/patch/resource/create'
import { updatePatchResource } from '~/app/api/patch/resource/update'

const resourceInput = {
  patchId: 10,
  section: 'galgame',
  name: 'Resource',
  note: 'Note',
  type: ['patch'],
  language: ['zh-cn'],
  platform: ['windows'],
  emulatorType: [],
  modelName: '',
  links: [
    {
      storage: 'mega',
      hash: '',
      content: 'https://example.com/file',
      size: '1 MB',
      code: '',
      password: ''
    }
  ]
}

const buildStoredResource = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: resourceInput.name,
  section: resourceInput.section,
  type: resourceInput.type,
  language: resourceInput.language,
  note: resourceInput.note,
  platform: resourceInput.platform,
  emulator_type: [],
  model_name: '',
  download: 0,
  links: [
    {
      id: 2,
      ...resourceInput.links[0],
      s3_key: '',
      sort_order: 0,
      download: 0
    }
  ],
  status: 0,
  user_id: 7,
  patch_id: 10,
  created: new Date('2026-01-01T00:00:00.000Z'),
  user: {
    id: 7,
    name: 'User',
    avatar: '',
    role: 2,
    _count: { patch_resource: 1 }
  },
  patch: { unique_id: 'patch-10' },
  ...overrides
})

beforeEach(() => {
  vi.resetAllMocks()
  transactionLinkFindManyMock.mockResolvedValue([])
  hasPendingModerationMock.mockResolvedValue(false)
  preScreenTextMock.mockResolvedValue(moderationSkip)
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
  moderationSkip.intercept = false
  moderationSkip.queue = false
  patchFindUniqueMock.mockResolvedValue({
    id: 10,
    unique_id: 'patch-10',
    name: 'Patch'
  })
  resourceCountMock.mockResolvedValue(3)
  transactionMock.mockImplementation(
    async (callback: (client: typeof transactionClient) => unknown) =>
      callback(transactionClient)
  )
  transactionUserUpdateMock.mockResolvedValue({})
  transactionPatchUpdateMock.mockResolvedValue({})
  // 行锁读回与快照一致的行以通过 update.ts 的锁下守卫复检, 维持既有用例语义
  transactionQueryRawMock.mockResolvedValue([{ status: 0, section: 'galgame' }])
})

// 资源详情缓存装 status=0 的全部 section, 资源列表只列 section='patch':
// 两个缓存的失效闸门必须分开, 否则 galgame section 的变更会漏掉详情缓存
describe('资源写入按 section 分派缓存失效', () => {
  it('创建 section=galgame 的公开资源只失效详情缓存', async () => {
    transactionResourceCreateMock.mockResolvedValue(buildStoredResource())

    await createPatchResource(resourceInput, 7, 2)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledWith(10)
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  })

  it('创建 section=patch 的公开资源两个缓存都失效', async () => {
    transactionResourceCreateMock.mockResolvedValue(
      buildStoredResource({ section: 'patch' })
    )

    await createPatchResource({ ...resourceInput, section: 'patch' }, 7, 2)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledWith(10)
    expect(invalidateResourceListCacheMock).toHaveBeenCalledTimes(1)
  })

  it('创建待审核资源两个缓存都不失效', async () => {
    transactionResourceCreateMock.mockResolvedValue(
      buildStoredResource({ status: 2 })
    )

    await createPatchResource(resourceInput, 7, 2)

    expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  })

  it('更新 section=galgame 的公开资源只失效详情缓存', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildStoredResource())
    transactionResourceUpdateMock.mockResolvedValue(buildStoredResource())

    await updatePatchResource({ ...resourceInput, resourceId: 1 }, 7, 2)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledWith(10)
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  })

  it('更新把 section 从 patch 改为 galgame 时两个缓存都失效', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      buildStoredResource({ section: 'patch' })
    )
    transactionQueryRawMock.mockResolvedValue([{ status: 0, section: 'patch' }])
    transactionResourceUpdateMock.mockResolvedValue(buildStoredResource())

    await updatePatchResource({ ...resourceInput, resourceId: 1 }, 7, 2)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledWith(10)
    expect(invalidateResourceListCacheMock).toHaveBeenCalledTimes(1)
  })

  // 离开公开集与进入公开集同样改变详情缓存内容
  it('更新使 galgame 资源被审核拦截 (0→3) 仍失效详情缓存', async () => {
    moderationSkip.intercept = true
    resourceFindUniqueMock.mockResolvedValue(buildStoredResource())
    transactionResourceUpdateMock.mockResolvedValue(
      buildStoredResource({ status: 3 })
    )

    await updatePatchResource(
      { ...resourceInput, resourceId: 1, note: 'Changed' },
      7,
      2
    )

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledWith(10)
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  })
})
