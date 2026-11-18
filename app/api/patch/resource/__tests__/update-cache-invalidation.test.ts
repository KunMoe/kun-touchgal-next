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

import { resourceSubject } from '~/server/moderation/subject'
import {
  frontResourceEditGuard,
  updatePatchResource
} from '~/app/api/patch/resource/update'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import type { KunRole } from '~/constants/role'

// 按前台入口的方式调用: 操作者, 加前台入口为它算出的守卫
const updateResource = (
  input: Parameters<typeof updatePatchResource>[0],
  uid: number,
  role: KunRole
) => {
  const actor = kunTestActor({ uid, role })
  return updatePatchResource(input, actor, frontResourceEditGuard(actor))
}

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
const SKIP = { queue: false, intercept: false, dryRun: false }

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
    planTextModerationMock.mockResolvedValue(INTERCEPT)
    transactionResourceUpdateMock.mockResolvedValue(
      buildUpdated({ status: 3, section: 'patch' })
    )

    await updateResource(buildInput({ section: 'patch' }), 9, 3)

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

    planTextModerationMock.mockResolvedValue(SKIP)

    const result = await updateResource(buildInput({ name: 'Old name' }), 9, 3)

    expect(result).toBe('未找到该资源')
    // 提交的送审字段与库中快照各成一个主体交给预筛, 由预筛判定是否重审
    const fields = { name: 'Old name', note: '', modelName: '' }
    expect(planTextModerationMock).toHaveBeenCalledWith(
      resourceSubject({
        ...fields,
        links: [
          {
            storage: 'user',
            content: 'https://example.com',
            size: '100MB',
            code: '',
            password: ''
          }
        ]
      }),
      {
        actor: expect.objectContaining({ uid: 9, role: 3 }),
        previous: resourceSubject({ ...fields, links: [] })
      }
    )
    expect(transactionResourceUpdateMock).not.toHaveBeenCalled()
    expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
  })

  it('公开资源正常编辑保持失效行为', async () => {
    resourceFindUniqueMock.mockResolvedValue(
      buildSnapshot({ section: 'patch' })
    )
    transactionQueryRawMock.mockResolvedValue([{ status: 0, section: 'patch' }])
    planTextModerationMock.mockResolvedValue({
      queue: true,
      intercept: false,
      dryRun: true
    })
    transactionResourceUpdateMock.mockResolvedValue(
      buildUpdated({ section: 'patch' })
    )

    await updateResource(buildInput({ section: 'patch' }), 7, 1)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateResourceListCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateUserPendingResourceCacheMock).not.toHaveBeenCalled()
  })

  it('无并发时编辑待审资源被拦截, 不触发公开缓存与 pending 失效', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot({ status: 3 }))
    transactionQueryRawMock.mockResolvedValue([
      { status: 3, section: 'galgame' }
    ])
    planTextModerationMock.mockResolvedValue(INTERCEPT)
    transactionResourceUpdateMock.mockResolvedValue(buildUpdated({ status: 3 }))

    await updateResource(buildInput(), 9, 3)

    expect(invalidatePatchResourceDetailCacheMock).not.toHaveBeenCalled()
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
    expect(invalidateUserPendingResourceCacheMock).not.toHaveBeenCalled()
  })

  // 内容更新 (第一条语句) 返回的行仍是公开态; 转待审核是随后单独的一条写入。响应里的
  // status 与提交后的缓存闸门必须读后者, 且它要排在聚合重算之前 (重算只读公开资源)
  it('被拦截时响应与缓存闸门读「转待审核」那条写入的结果, 且它先于聚合重算', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    planTextModerationMock.mockResolvedValue(INTERCEPT)
    transactionResourceUpdateMock
      .mockResolvedValueOnce(buildUpdated({ status: 0 }))
      .mockResolvedValueOnce({ status: 3 })

    const result = await updateResource(buildInput(), 7, 1)

    expect(result).toMatchObject({ status: 3 })
    expect(transactionResourceUpdateMock.mock.calls[1][0]).toEqual({
      where: { id: 1 },
      data: { status: 3 },
      select: { status: true }
    })
    expect(
      transactionResourceUpdateMock.mock.invocationCallOrder[1]
    ).toBeLessThan(recalcPatchTypeMock.mock.invocationCallOrder[0])
    // 0→3: 作者的「有待审资源」标记翻真
    expect(invalidateUserPendingResourceCacheMock).toHaveBeenCalledWith(7)
  })

  it('公开资源被拦截转待审, 失效详情缓存与 pending 缓存', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    planTextModerationMock.mockResolvedValue(INTERCEPT)
    transactionResourceUpdateMock.mockResolvedValue(buildUpdated({ status: 3 }))

    await updateResource(buildInput(), 7, 1)

    expect(invalidatePatchResourceDetailCacheMock).toHaveBeenCalledTimes(1)
    expect(invalidateResourceListCacheMock).not.toHaveBeenCalled()
    expect(invalidateUserPendingResourceCacheMock).toHaveBeenCalledWith(7)
  })
})

// 写入体逐字段列出校验结构里的字段。展开整个输入的话, 以后新增的字段 (比如 status)
// 会不经意落库, 绕过「status 只在 server/content 的命令里写」(kun/inv-content-06)
describe('资源编辑写入的字段', () => {
  it('只写列出的字段、联动字段与链接; 输入里多出来的键不落库', async () => {
    resourceFindUniqueMock.mockResolvedValue(buildSnapshot())
    planTextModerationMock.mockResolvedValue(SKIP)
    transactionResourceUpdateMock.mockResolvedValue(buildUpdated())

    await updateResource(
      buildInput({ note: '备注', status: 2, download: 999 }),
      7,
      1
    )

    const { data } = transactionResourceUpdateMock.mock.calls[0][0]
    expect(Object.keys(data).sort()).toEqual([
      'emulator_type',
      'language',
      'links',
      'model_name',
      'name',
      'note',
      'platform',
      'section',
      'type'
    ])
    expect(data).toMatchObject({
      section: 'galgame',
      name: 'New name',
      note: '备注',
      type: ['manual'],
      language: ['zh-Hans'],
      platform: ['windows'],
      emulator_type: [],
      model_name: ''
    })
  })
})
