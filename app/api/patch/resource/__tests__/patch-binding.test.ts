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
  section: 'patch',
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

const storedResource = {
  id: 1,
  name: resourceInput.name,
  section: resourceInput.section,
  type: resourceInput.type,
  language: resourceInput.language,
  note: resourceInput.note,
  platform: resourceInput.platform,
  emulator_type: [],
  model_name: '',
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
  patch: { unique_id: 'patch-10' }
}

beforeEach(() => {
  vi.clearAllMocks()
  transactionLinkFindManyMock.mockResolvedValue([])
  hasPendingModerationMock.mockResolvedValue(false)
  preScreenTextMock.mockResolvedValue(moderationSkip)
  invalidatePatchContentCacheMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (client: typeof transactionClient) => unknown) =>
      callback(transactionClient)
  )
  transactionResourceCreateMock.mockResolvedValue(storedResource)
  transactionResourceUpdateMock.mockResolvedValue(storedResource)
  transactionUserUpdateMock.mockResolvedValue({})
  transactionPatchUpdateMock.mockResolvedValue({})
  // 行锁读回与快照一致的行以通过 update.ts 的锁下守卫复检, 维持既有用例语义
  transactionQueryRawMock.mockResolvedValue([{ status: 0, section: 'patch' }])
})

describe('资源写入 patch 绑定', () => {
  it('拒绝用自有资源更新其他 patch', async () => {
    resourceFindUniqueMock.mockResolvedValue({
      ...storedResource,
      links: []
    })

    const result = await updatePatchResource(
      { ...resourceInput, resourceId: 1, patchId: 20 },
      7,
      2
    )

    expect(result).toBe('资源与 Galgame 不匹配')
    expect(bindUploadedResourceMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
    expect(recalcPatchTypeMock).not.toHaveBeenCalled()
    expect(enqueueSearchOutboxMock).not.toHaveBeenCalled()
    expect(queueSearchSyncMock).not.toHaveBeenCalled()
  })

  it('patch 在资源查询后被删除时不绑定 S3 文件', async () => {
    resourceFindUniqueMock.mockResolvedValue({
      ...storedResource,
      links: []
    })
    patchFindUniqueMock.mockResolvedValue(null)

    const result = await updatePatchResource(
      {
        ...resourceInput,
        resourceId: 1,
        links: [
          {
            ...resourceInput.links[0],
            storage: 's3',
            hash: 'upload-token',
            content: ''
          }
        ]
      },
      7,
      2
    )

    expect(result).toBe('未找到该资源对应的 Galgame 信息, 请确认 Galgame 存在')
    expect(bindUploadedResourceMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('更新资源时只写入资源真实关联的 patch', async () => {
    resourceFindUniqueMock.mockResolvedValue({
      ...storedResource,
      links: []
    })
    patchFindUniqueMock.mockResolvedValue({ id: 10 })

    await updatePatchResource({ ...resourceInput, resourceId: 1 }, 7, 2)

    expect(patchFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 10 },
      select: { id: true }
    })
    expect(transactionPatchUpdateMock).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { resource_update_time: expect.any(Date) }
    })
    expect(recalcPatchTypeMock).toHaveBeenCalledWith(10, transactionClient)
    expect(enqueueSearchOutboxMock).toHaveBeenCalledWith(transactionClient, 10)
    expect(queueSearchSyncMock).toHaveBeenCalledWith(10)
  })

  it('目标 patch 不存在时在 S3 绑定前拒绝创建资源', async () => {
    patchFindUniqueMock.mockResolvedValue(null)
    resourceCountMock.mockResolvedValue(1)

    const result = await createPatchResource(
      {
        ...resourceInput,
        patchId: 20,
        links: [
          {
            ...resourceInput.links[0],
            storage: 's3',
            hash: 'upload-token',
            content: ''
          }
        ]
      },
      7,
      2
    )

    expect(result).toBe('未找到该资源对应的 Galgame 信息, 请确认 Galgame 存在')
    expect(preScreenTextMock).not.toHaveBeenCalled()
    expect(bindUploadedResourceMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('创建资源时使用已确认存在的 patch ID', async () => {
    patchFindUniqueMock.mockResolvedValue({
      id: 10,
      unique_id: 'patch-10',
      name: 'Game'
    })
    resourceCountMock.mockResolvedValue(1)

    await createPatchResource(resourceInput, 7, 2)

    expect(transactionResourceCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ patch_id: 10 })
      })
    )
    expect(transactionPatchUpdateMock).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { resource_update_time: expect.any(Date) }
    })
    expect(recalcPatchTypeMock).toHaveBeenCalledWith(10, transactionClient)
    expect(enqueueSearchOutboxMock).toHaveBeenCalledWith(transactionClient, 10)
    expect(queueSearchSyncMock).toHaveBeenCalledWith(10)
  })
})
