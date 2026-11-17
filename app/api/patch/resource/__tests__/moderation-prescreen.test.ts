import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  bindUploadedResourceMock,
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
  bindUploadedResourceMock: vi.fn(),
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
  bindUploadedResource: bindUploadedResourceMock,
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

const externalLink = resourceInput.links[0]
const LINK_SEGMENT = {
  label: '链接',
  kind: 'plain',
  value: externalLink.content
}
const SIZE_SEGMENT = { label: '大小', kind: 'plain', value: externalLink.size }
// patch_resource_link 行: 与 externalLink 对应的库中快照
const storedExternalLink = {
  id: 3,
  storage: externalLink.storage,
  content: externalLink.content,
  code: '',
  password: '',
  hash: '',
  s3_key: '',
  size: externalLink.size,
  sort_order: 0,
  download: 0
}

describe('资源审核预筛选: 送审标题、介绍、模型型号与各条链接的自由文本', () => {
  // 链接文本、大小、提取码、解压码向所有访客展示, 与标题、介绍一样要过审 (X09-03)
  it('只有外链、标题介绍全空的资源也要送审', async () => {
    await createPatchResource(resourceInput, 7, 2)

    expect(createdTaskData().payload.segments).toEqual([
      LINK_SEGMENT,
      SIZE_SEGMENT
    ])
    expect(transactionResourceCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 3 })
      })
    )
  })

  // 「大小」只要求以 MB / GB 结尾, 前面写什么都行; 每条链接都有它, 所以带链接的资源
  // 不存在「没有可审文本」的情况, 站内存储的也一样
  it('只有站内存储链接、其余全空的资源仍要送审它的大小字段', async () => {
    bindUploadedResourceMock.mockResolvedValue({
      downloadLink: 'https://cdn.example/file',
      s3Key: 'patch/10/file'
    })

    await createPatchResource(
      {
        ...resourceInput,
        links: [
          {
            ...externalLink,
            storage: 's3',
            hash: 'upload-token',
            content: '',
            size: '加微信 vx123456789 代充 GB'
          }
        ]
      },
      7,
      2
    )

    expect(createdTaskData().payload.segments).toEqual([
      { label: '大小', kind: 'plain', value: '加微信 vx123456789 代充 GB' }
    ])
    expect(transactionResourceCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 3 })
      })
    )
  })

  it('创建含标题的资源: 任务携带主体段与资源名, 资源进入待审核', async () => {
    await createPatchResource({ ...resourceInput, name: 'Patch v1' }, 7, 2)

    expect(createdTaskData()).toMatchObject({
      content_type: 'resource',
      content_id: 1,
      patch_id: 10,
      user_id: 7,
      dry_run: false,
      payload: {
        v: 2,
        segments: [
          { label: '标题', kind: 'plain', value: 'Patch v1' },
          LINK_SEGMENT,
          SIZE_SEGMENT
        ],
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
      { label: '模型型号', kind: 'plain', value: 'GPT-4o' },
      LINK_SEGMENT,
      SIZE_SEGMENT
    ])
    expect(taskCreateMock.mock.calls[1][0].data.payload.segments).toEqual([
      { label: '标题', kind: 'plain', value: 'Patch v1' },
      LINK_SEGMENT,
      SIZE_SEGMENT
    ])
  })

  it('多条链接的字段带序号; 站内存储的链接地址不是用户输入, 不送审', async () => {
    bindUploadedResourceMock.mockResolvedValue({
      downloadLink: 'https://cdn.example/file',
      s3Key: 'patch/10/file'
    })

    await createPatchResource(
      {
        ...resourceInput,
        links: [
          { ...externalLink, code: 'abcd', password: '解压码 touchgal' },
          {
            ...externalLink,
            storage: 's3',
            hash: 'upload-token',
            content: '',
            password: '加群 987654321 获取'
          }
        ]
      },
      7,
      2
    )

    expect(createdTaskData().payload.segments).toEqual([
      { label: '链接 1', kind: 'plain', value: externalLink.content },
      { ...SIZE_SEGMENT, label: '大小 1' },
      { label: '提取码 1', kind: 'plain', value: 'abcd' },
      { label: '解压码 1', kind: 'plain', value: '解压码 touchgal' },
      { ...SIZE_SEGMENT, label: '大小 2' },
      { label: '解压码 2', kind: 'plain', value: '加群 987654321 获取' }
    ])
  })

  it('超级管理员 (role 4) 创建资源不送审', async () => {
    await createPatchResource({ ...resourceInput, name: 'Patch v1' }, 7, 4)

    expect(getModerationConfigMock).not.toHaveBeenCalled()
    expect(taskCreateMock).not.toHaveBeenCalled()
  })

  // 旧实现只比较标题、介绍、型号: 先发正常资源再把链接改成引流地址, 连任务都不建
  it('只改链接也要重新送审, 资源转待审核', async () => {
    resourceFindUniqueMock.mockResolvedValue({
      ...storedResource,
      links: [storedExternalLink]
    })

    await updatePatchResource(
      {
        ...resourceInput,
        resourceId: 1,
        name: storedResource.name,
        note: storedResource.note,
        links: [{ ...externalLink, content: 'https://evil.example/join' }]
      },
      7,
      2
    )

    expect(createdTaskData().payload.segments).toEqual([
      { label: '标题', kind: 'plain', value: 'Resource' },
      { label: '介绍', kind: 'markdown-standard', value: 'Note' },
      { label: '链接', kind: 'plain', value: 'https://evil.example/join' },
      SIZE_SEGMENT
    ])
    expect(transactionResourceUpdateMock.mock.calls[0][0].data.status).toBe(3)
  })

  it.each([
    ['解压码', { password: '付费获取解压码' }],
    ['提取码', { code: '加群拿码' }],
    ['大小', { size: '加微信 vx123456789 代充 GB' }]
  ])('只改%s同样重新送审', async (_name, change) => {
    resourceFindUniqueMock.mockResolvedValue({
      ...storedResource,
      links: [storedExternalLink]
    })

    await updatePatchResource(
      {
        ...resourceInput,
        resourceId: 1,
        name: storedResource.name,
        note: storedResource.note,
        links: [{ ...externalLink, ...change }]
      },
      7,
      2
    )

    expect(taskCreateMock).toHaveBeenCalledTimes(1)
    expect(transactionResourceUpdateMock.mock.calls[0][0].data.status).toBe(3)
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
        segments: [
          { label: '标题', kind: 'plain', value: 'Patch v2' },
          LINK_SEGMENT,
          SIZE_SEGMENT
        ],
        name: 'Resource'
      }
    })
    expect(transactionResourceUpdateMock.mock.calls[0][0].data.status).toBe(3)
  })

  it('送审字段与库中一致时不重审, 也不读审核配置; 只换外链的存储类型这类枚举值同理', async () => {
    resourceFindUniqueMock.mockResolvedValue({
      ...storedResource,
      links: [storedExternalLink]
    })

    await updatePatchResource(
      {
        ...resourceInput,
        resourceId: 1,
        name: storedResource.name,
        note: storedResource.note,
        links: [{ ...externalLink, storage: 'user' }]
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

// 嵌套超出渲染预算的 markdown 详情页渲染不出来 (只能降级成纯文本), 所以落库前就拒绝;
// 拒绝要发生在预筛与 S3 绑定之前, 否则白建任务、白复制对象
describe('渲染不出来的资源介绍', () => {
  const note = `${'>'.repeat(300)} x`

  it('创建时被拒, 不预筛、不绑定、不写库', async () => {
    const result = await createPatchResource({ ...resourceInput, note }, 7, 2)

    expect(result).toBe(
      '资源备注中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )
    expect(getModerationConfigMock).not.toHaveBeenCalled()
    expect(bindUploadedResourceMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })

  it('编辑时被拒, 不预筛、不绑定、不写库', async () => {
    resourceFindUniqueMock.mockResolvedValue(storedResource)

    const result = await updatePatchResource(
      { ...resourceInput, resourceId: 1, note },
      7,
      2
    )

    expect(result).toBe(
      '资源备注中的引用、列表、方括号等格式嵌套过多, 请精简后再提交'
    )
    expect(getModerationConfigMock).not.toHaveBeenCalled()
    expect(bindUploadedResourceMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  })
})
