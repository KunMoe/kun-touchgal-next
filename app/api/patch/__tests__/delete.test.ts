import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  findPatchMock,
  findResourcesMock,
  transactionMock,
  txQueryRawMock,
  findCommentsMock,
  findRatingsMock,
  resourceDeleteMock,
  patchDeleteMock,
  deleteTasksMock,
  deleteAppealsMock,
  enqueueDeletionsMock,
  kickDrainMock,
  invalidateCacheMock,
  invalidateContentMock,
  invalidatePendingMock,
  queueSearchRemoveMock,
  enqueueS3DeletionMock
} = vi.hoisted(() => ({
  findPatchMock: vi.fn(),
  findResourcesMock: vi.fn(),
  transactionMock: vi.fn(),
  txQueryRawMock: vi.fn(),
  findCommentsMock: vi.fn(),
  findRatingsMock: vi.fn(),
  resourceDeleteMock: vi.fn(),
  patchDeleteMock: vi.fn(),
  deleteTasksMock: vi.fn(),
  deleteAppealsMock: vi.fn(),
  enqueueDeletionsMock: vi.fn(),
  kickDrainMock: vi.fn(),
  invalidateCacheMock: vi.fn(),
  invalidateContentMock: vi.fn(),
  invalidatePendingMock: vi.fn(),
  queueSearchRemoveMock: vi.fn(),
  enqueueS3DeletionMock: vi.fn()
}))

const transactionClient = {
  patch_comment: { findMany: findCommentsMock },
  patch_rating: { findMany: findRatingsMock },
  // findMany 挂在事务客户端上: links 与清理 id 集在行锁下重读, 不再用事务外快照
  patch_resource: { delete: resourceDeleteMock, findMany: findResourcesMock },
  patch: { delete: patchDeleteMock },
  $queryRaw: txQueryRawMock
}

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findUnique: findPatchMock },
    $transaction: transactionMock
  }
}))

vi.mock('~/app/api/patch/resource/_helper', () => ({
  enqueueResourceLinkDeletions: enqueueDeletionsMock
}))

vi.mock('~/server/storage/s3Outbox', () => ({
  kickS3DeletionDrain: kickDrainMock,
  enqueueS3Deletion: enqueueS3DeletionMock
}))

vi.mock('~/app/api/resource/cache', () => ({
  invalidateResourceListCache: invalidateCacheMock
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: invalidateContentMock
}))

vi.mock('~/app/api/utils/pendingResourceCache', () => ({
  invalidateUserPendingResourceCache: invalidatePendingMock
}))

vi.mock('~/server/moderation/submit', () => ({
  deletePendingModerationTasks: deleteTasksMock
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: deleteAppealsMock
}))

vi.mock('~/server/search/sync', () => ({
  queueSearchRemove: queueSearchRemoveMock,
  enqueueSearchOutbox: vi.fn()
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import { deletePatchById } from '~/app/api/patch/delete'

const BED = 'https://img.example.test'
const UUID = '0f8c8a8e-3a3b-4c5d-9e6f-1a2b3c4d5e6f'

const resource = (id: number, status: number, section: string) => ({
  id,
  patch_id: 7,
  user_id: 100 + id,
  status,
  section,
  links: [
    {
      storage: 's3',
      content: `content-${id}`,
      hash: `hash-${id}`,
      s3_key: `key-${id}`
    },
    {
      storage: 'user',
      content: `user-content-${id}`,
      hash: '',
      s3_key: ''
    }
  ]
})

beforeEach(() => {
  vi.clearAllMocks()
  txQueryRawMock.mockResolvedValue([])
  findPatchMock.mockResolvedValue({ id: 7, unique_id: 'abcd1234' })
  findResourcesMock.mockResolvedValue([
    resource(1, 0, 'patch'),
    resource(2, 1, 'game')
  ])
  findCommentsMock.mockResolvedValue([{ id: 11 }])
  findRatingsMock.mockResolvedValue([{ id: 21 }])
  vi.stubEnv('KUN_VISUAL_NOVEL_IMAGE_BED_URL', BED)
  patchDeleteMock.mockResolvedValue({
    id: 7,
    banner: `${BED}/patch/7/banner/${UUID}/banner.avif`
  })
  deleteTasksMock.mockResolvedValue(undefined)
  deleteAppealsMock.mockResolvedValue(undefined)
  enqueueDeletionsMock.mockResolvedValue(undefined)
  invalidateCacheMock.mockResolvedValue(undefined)
  invalidateContentMock.mockResolvedValue(undefined)
  transactionMock.mockImplementation(
    async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient)
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('deletePatchById', () => {
  it('relies on patch cascade instead of per-resource deletes while keeping cleanup inputs', async () => {
    await expect(deletePatchById({ patchId: 7 })).resolves.toEqual({})

    expect(resourceDeleteMock).not.toHaveBeenCalled()
    expect(patchDeleteMock).toHaveBeenCalledTimes(1)
    expect(patchDeleteMock).toHaveBeenCalledWith({ where: { id: 7 } })

    expect(deleteTasksMock).toHaveBeenCalledWith(
      'resource',
      [1, 2],
      transactionClient
    )
    expect(deleteAppealsMock).toHaveBeenCalledWith(
      'resource',
      [1, 2],
      transactionClient
    )

    // S3 删除意图在事务内入队 (与行删除原子提交)，而非提交后 Promise.all 直删
    expect(enqueueDeletionsMock).toHaveBeenCalledTimes(1)
    expect(enqueueDeletionsMock).toHaveBeenCalledWith(transactionClient, [
      { s3Key: 'key-1' },
      { s3Key: 'key-2' }
    ])
    // 提交后即时消费出箱
    expect(kickDrainMock).toHaveBeenCalledTimes(1)

    expect(invalidateCacheMock).toHaveBeenCalledTimes(1)
    // content/introduction 缓存键按 unique_id 删除后仍可达, 必须提交后失效
    expect(invalidateContentMock).toHaveBeenCalledTimes(1)
    expect(invalidateContentMock).toHaveBeenCalledWith('abcd1234')
    expect(queueSearchRemoveMock).toHaveBeenCalledWith(7)
  })

  // 封面没有链接行, 只能按 delete 返回的指针推出那个版本的对象 (X06-01)
  it('enqueues the banner version named by the pointer that delete() returned, without delay', async () => {
    await expect(deletePatchById({ patchId: 7 })).resolves.toEqual({})

    expect(enqueueS3DeletionMock).toHaveBeenCalledTimes(1)
    expect(enqueueS3DeletionMock).toHaveBeenCalledWith(
      transactionClient,
      [
        `patch/7/banner/${UUID}/banner.avif`,
        `patch/7/banner/${UUID}/banner-mini.avif`,
        `patch/7/banner/${UUID}/banner-full.avif`
      ],
      {}
    )
  })

  it('does not enqueue anything for a pointer outside the configured image bed', async () => {
    patchDeleteMock.mockResolvedValue({
      id: 7,
      banner: 'https://elsewhere.example.test/patch/7/banner/banner.avif'
    })

    await expect(deletePatchById({ patchId: 7 })).resolves.toEqual({})

    expect(enqueueS3DeletionMock).not.toHaveBeenCalled()
    // 没 mock 的标签 / 会社列表缓存失效连不上 Redis 也会记日志, 只数这一个事件
    expect(
      vi
        .mocked(kunLog)
        .mock.calls.filter(([event]) => event === 'banner.pointer_unrecognized')
    ).toEqual([
      [
        'banner.pointer_unrecognized',
        {
          patchId: 7,
          pointer: 'https://elsewhere.example.test/patch/7/banner/banner.avif'
        }
      ]
    ])
  })

  it('still resolves when patch content cache invalidation fails', async () => {
    invalidateContentMock.mockRejectedValue(new Error('redis down'))

    await expect(deletePatchById({ patchId: 7 })).resolves.toEqual({})
  })

  it('skips resource list cache invalidation when no visible patch resource exists', async () => {
    findResourcesMock.mockResolvedValue([
      resource(1, 1, 'patch'),
      resource(2, 0, 'game')
    ])

    await expect(deletePatchById({ patchId: 7 })).resolves.toEqual({})

    expect(invalidateCacheMock).not.toHaveBeenCalled()
  })

  // 作者的待审标记 (hasPendingResource) 随待初审 / 待审核资源一起消失
  it('invalidates the pending flag of owners whose awaiting resources are cascaded', async () => {
    findResourcesMock.mockResolvedValue([
      resource(1, 0, 'patch'),
      resource(2, 2, 'patch'),
      resource(3, 3, 'game'),
      resource(4, 1, 'game')
    ])

    await expect(deletePatchById({ patchId: 7 })).resolves.toEqual({})

    expect(invalidatePendingMock.mock.calls).toEqual([[102], [103]])
  })

  it('returns an error message when the patch does not exist', async () => {
    findPatchMock.mockResolvedValue(null)

    await expect(deletePatchById({ patchId: 7 })).resolves.toBe('未找到该游戏')
    expect(transactionMock).not.toHaveBeenCalled()
    expect(invalidateContentMock).not.toHaveBeenCalled()
  })
})
