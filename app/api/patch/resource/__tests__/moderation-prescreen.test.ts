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
  taskCountMock,
  taskUpdateManyMock,
  taskCreateMock,
  getModerationConfigMock,
  createMessageMock,
  invalidateUnreadMock
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
  taskCountMock: vi.fn(),
  taskUpdateManyMock: vi.fn(),
  taskCreateMock: vi.fn(),
  getModerationConfigMock: vi.fn(),
  createMessageMock: vi.fn(),
  invalidateUnreadMock: vi.fn()
}))

const transactionClient = {
  patch_resource: {
    create: transactionResourceCreateMock,
    update: transactionResourceUpdateMock
  },
  patch_resource_link: { findMany: transactionLinkFindManyMock },
  moderation_task: { updateMany: taskUpdateManyMock, create: taskCreateMock },
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
    moderation_task: { count: taskCountMock },
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

// 送审入口 (plan / enqueue) 走真实实现, 只替换它读的审核配置: 这里验证的正是
// 「调用点交出的主体 → 是否建任务、任务里有哪些段」这一整段
vi.mock('~/server/moderation/config', () => ({
  getModerationConfig: getModerationConfigMock
}))

vi.mock('~/app/api/utils/message', () => ({
  createMessage: createMessageMock
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: invalidateUnreadMock
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
  taskCountMock.mockResolvedValue(0)
  taskUpdateManyMock.mockResolvedValue({ count: 0 })
  taskCreateMock.mockResolvedValue({ id: 1 })
  getModerationConfigMock.mockResolvedValue({ enabled: true, dryRun: false })
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

const createdTaskData = () => taskCreateMock.mock.calls[0][0].data

describe('资源审核预筛选: 送审字段全空时直接放行', () => {
  it('创建空标题空介绍的资源不送审、状态直接公开', async () => {
    await createPatchResource(resourceInput, 7, 2)

    expect(getModerationConfigMock).not.toHaveBeenCalled()
    expect(taskCreateMock).not.toHaveBeenCalled()
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

    expect(getModerationConfigMock).not.toHaveBeenCalled()
    expect(taskCreateMock).not.toHaveBeenCalled()
  })

  it('创建含标题的资源正常送审: 任务携带主体段与资源名, 资源进入待审核', async () => {
    await createPatchResource({ ...resourceInput, name: 'Patch v1' }, 7, 2)

    expect(createdTaskData()).toMatchObject({
      content_type: 'resource',
      content_id: 1,
      patch_id: 10,
      user_id: 7,
      dry_run: false,
      payload: {
        v: 2,
        segments: [{ label: '标题', kind: 'plain', value: 'Patch v1' }],
        name: 'Resource'
      }
    })
    expect(transactionResourceCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 3 })
      })
    )
  })

  it('标题、介绍、模型型号各成一段; 未选 AI 类型时模型型号不落库也不送审', async () => {
    await createPatchResource(
      {
        ...resourceInput,
        name: 'Patch v1',
        note: '**汉化**说明',
        type: ['ai'],
        modelName: 'GPT-4o'
      },
      7,
      2
    )
    await createPatchResource(
      { ...resourceInput, name: 'Patch v1', modelName: 'GPT-4o' },
      7,
      2
    )

    expect(taskCreateMock.mock.calls[0][0].data.payload.segments).toEqual([
      { label: '标题', kind: 'plain', value: 'Patch v1' },
      { label: '介绍', kind: 'markdown-standard', value: '**汉化**说明' },
      { label: '模型型号', kind: 'plain', value: 'GPT-4o' }
    ])
    expect(taskCreateMock.mock.calls[1][0].data.payload.segments).toEqual([
      { label: '标题', kind: 'plain', value: 'Patch v1' }
    ])
  })

  it('超级管理员 (role 4) 创建资源不送审', async () => {
    await createPatchResource({ ...resourceInput, name: 'Patch v1' }, 7, 4)

    expect(getModerationConfigMock).not.toHaveBeenCalled()
    expect(taskCreateMock).not.toHaveBeenCalled()
  })

  it('更新为空标题空介绍时不送审、不拦截', async () => {
    resourceFindUniqueMock.mockResolvedValue(storedResource)

    await updatePatchResource({ ...resourceInput, resourceId: 1 }, 7, 2)

    expect(getModerationConfigMock).not.toHaveBeenCalled()
    expect(taskCreateMock).not.toHaveBeenCalled()
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

    expect(createdTaskData()).toMatchObject({
      content_type: 'resource',
      content_id: 1,
      patch_id: 10,
      user_id: 7,
      payload: {
        segments: [{ label: '标题', kind: 'plain', value: 'Patch v2' }],
        name: 'Resource'
      }
    })
    expect(transactionResourceUpdateMock.mock.calls[0][0].data.status).toBe(3)
  })

  it('更新时送审字段与库中一致则不重审, 也不读审核配置', async () => {
    resourceFindUniqueMock.mockResolvedValue(storedResource)

    await updatePatchResource(
      {
        ...resourceInput,
        resourceId: 1,
        name: storedResource.name,
        note: storedResource.note
      },
      7,
      2
    )

    expect(getModerationConfigMock).not.toHaveBeenCalled()
    expect(taskCreateMock).not.toHaveBeenCalled()
    expect(
      transactionResourceUpdateMock.mock.calls[0][0].data.status
    ).toBeUndefined()
  })
})

describe('首个资源人工审批通知', () => {
  it('首个资源提交后通知上传者并在写入后失效其未读缓存', async () => {
    resourceCountMock.mockResolvedValue(0)

    await createPatchResource({ ...resourceInput, name: 'Patch v1' }, 7, 2)

    // 首个资源走人工审批流, 不送 AI 审核
    expect(getModerationConfigMock).not.toHaveBeenCalled()
    expect(taskCreateMock).not.toHaveBeenCalled()
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
