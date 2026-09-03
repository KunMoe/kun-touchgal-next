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
  preScreenTextMock,
  hasPendingModerationMock,
  createModerationTaskMock,
  createMessageMock,
  invalidateUnreadMock,
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
  preScreenTextMock: vi.fn(),
  hasPendingModerationMock: vi.fn(),
  createModerationTaskMock: vi.fn(),
  createMessageMock: vi.fn(),
  invalidateUnreadMock: vi.fn(),
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
  bindUploadedResource: vi.fn(),
  enqueueResourceLinkDeletions: vi.fn(),
  recalcPatchType: vi.fn()
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: vi.fn()
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: vi.fn()
}))

vi.mock('~/server/search/sync', () => ({
  enqueueSearchOutbox: vi.fn(),
  queueSearchSync: vi.fn()
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: vi.fn()
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

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
}))

vi.mock('~/app/api/utils/render/markdownToHtml', () => ({
  markdownToHtml: vi.fn().mockResolvedValue('<p>Note</p>')
}))

import { createPatchResource } from '~/app/api/patch/resource/create'
import { updatePatchResource } from '~/app/api/patch/resource/update'

const resourceInput = {
  patchId: 10,
  section: 'patch',
  name: '',
  note: '',
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
  name: 'Resource',
  section: 'patch',
  type: resourceInput.type,
  language: resourceInput.language,
  note: 'Note',
  platform: resourceInput.platform,
  emulator_type: [],
  model_name: '',
  links: [],
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
  preScreenTextMock.mockResolvedValue({
    intercept: true,
    queue: true,
    dryRun: false
  })
  patchFindUniqueMock.mockResolvedValue({
    id: 10,
    unique_id: 'patch-10',
    name: 'Game'
  })
  resourceCountMock.mockResolvedValue(1)
  createMessageMock.mockResolvedValue({})
  invalidateUnreadMock.mockResolvedValue(undefined)
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

describe('资源审核预筛选: 标题与介绍均为空时直接放行', () => {
  it('创建空标题空介绍的资源不送审、状态直接公开', async () => {
    await createPatchResource(resourceInput, 7, 2)

    expect(preScreenTextMock).not.toHaveBeenCalled()
    expect(createModerationTaskMock).not.toHaveBeenCalled()
    expect(transactionResourceCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 0 })
      })
    )
  })

  it('创建纯空白标题介绍的资源同样直接放行', async () => {
    await createPatchResource(
      { ...resourceInput, name: '  ', note: '\n' },
      7,
      2
    )

    expect(preScreenTextMock).not.toHaveBeenCalled()
    expect(createModerationTaskMock).not.toHaveBeenCalled()
  })

  it('创建含标题的资源仍正常送审、角色透传给预筛', async () => {
    await createPatchResource({ ...resourceInput, name: 'Patch v1' }, 7, 2)

    expect(preScreenTextMock).toHaveBeenCalledWith('标题: Patch v1\n介绍: ', 2)
    expect(createModerationTaskMock).toHaveBeenCalled()
    expect(transactionResourceCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 3 })
      })
    )
  })

  it('更新为空标题空介绍时不送审、不拦截', async () => {
    resourceFindUniqueMock.mockResolvedValue(storedResource)

    await updatePatchResource({ ...resourceInput, resourceId: 1 }, 7, 2)

    expect(preScreenTextMock).not.toHaveBeenCalled()
    expect(createModerationTaskMock).not.toHaveBeenCalled()
    expect(
      transactionResourceUpdateMock.mock.calls[0][0].data.status
    ).toBeUndefined()
  })

  it('更新为非空标题时仍正常送审', async () => {
    resourceFindUniqueMock.mockResolvedValue(storedResource)

    await updatePatchResource(
      { ...resourceInput, resourceId: 1, name: 'Patch v2' },
      7,
      2
    )

    expect(preScreenTextMock).toHaveBeenCalledWith('标题: Patch v2\n介绍: ', 2)
    expect(createModerationTaskMock).toHaveBeenCalled()
    expect(transactionResourceUpdateMock.mock.calls[0][0].data.status).toBe(3)
  })
})

describe('首个资源人工审批通知', () => {
  it('首个资源提交后通知上传者并在写入后失效其未读缓存', async () => {
    resourceCountMock.mockResolvedValue(0)

    await createPatchResource({ ...resourceInput, name: 'Patch v1' }, 7, 2)

    // 首个资源走人工审批流, 不送 AI 审核
    expect(preScreenTextMock).not.toHaveBeenCalled()
    expect(createMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'system', recipient_id: 7 })
    )
    expect(invalidateUnreadMock).toHaveBeenCalledWith(7)
    expect(createMessageMock.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateUnreadMock.mock.invocationCallOrder[0]
    )
  })

  it('非首个资源不发通知也不失效未读缓存', async () => {
    await createPatchResource({ ...resourceInput, name: 'Patch v1' }, 7, 2)

    expect(createMessageMock).not.toHaveBeenCalled()
    expect(invalidateUnreadMock).not.toHaveBeenCalled()
  })
})
