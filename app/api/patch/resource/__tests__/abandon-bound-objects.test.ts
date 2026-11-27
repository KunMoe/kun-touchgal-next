import { beforeEach, describe, expect, it, vi } from 'vitest'

const { enqueueS3DeletionMock, kickS3DeletionDrainMock, prismaMock } =
  vi.hoisted(() => ({
    enqueueS3DeletionMock: vi.fn(),
    kickS3DeletionDrainMock: vi.fn(),
    prismaMock: {}
  }))

vi.mock('~/lib/s3', () => ({
  copyObject: vi.fn(),
  deleteFileFromS3: vi.fn(),
  headObject: vi.fn()
}))

vi.mock('~/lib/redis', () => ({
  acquireKvLock: vi.fn(),
  delKv: vi.fn(),
  getKv: vi.fn(),
  releaseKvLock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({ prisma: prismaMock }))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

vi.mock('~/server/storage/s3Outbox', () => ({
  enqueueS3Deletion: enqueueS3DeletionMock,
  kickS3DeletionDrain: kickS3DeletionDrainMock
}))

vi.mock('~/server/moderation/submit', () => ({
  deletePendingModerationTasks: vi.fn()
}))

vi.mock('~/server/moderation/appeal', () => ({
  deletePendingAppeals: vi.fn()
}))

vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchContentCache: vi.fn()
}))

vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

import {
  abandonBoundResourceObjects,
  enqueueResourceLinkDeletions
} from '~/app/api/patch/resource/_helper'
import { kunLog } from '~/lib/log.server'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('abandonBoundResourceObjects', () => {
  it('空集合不入队不踢 drain', async () => {
    await abandonBoundResourceObjects([])

    expect(enqueueS3DeletionMock).not.toHaveBeenCalled()
    expect(kickS3DeletionDrainMock).not.toHaveBeenCalled()
  })

  it('非空集合按 s3Key 入删除出箱并即时踢 drain', async () => {
    enqueueS3DeletionMock.mockResolvedValue(undefined)

    await abandonBoundResourceObjects([{ s3Key: 'k-a' }, { s3Key: 'k-b' }])

    expect(enqueueS3DeletionMock).toHaveBeenCalledWith(prismaMock, [
      'k-a',
      'k-b'
    ])
    expect(kickS3DeletionDrainMock).toHaveBeenCalledTimes(1)
  })

  it('入队失败自吞不抛, 不遮蔽调用方正在返回的业务错误', async () => {
    enqueueS3DeletionMock.mockRejectedValue(new Error('db down'))

    await expect(
      abandonBoundResourceObjects([{ s3Key: 'k-a' }])
    ).resolves.toBeUndefined()
    expect(kickS3DeletionDrainMock).not.toHaveBeenCalled()
  })
})

// 对象的 key 只取链接行的 s3_key。从地址与 hash 拼 key 的旧公式已删: 没有 key 的行宁可
// 留下对象, 也不去删一个猜出来的 key (hash 被写空的行曾拼出 resource//文件名)
describe('enqueueResourceLinkDeletions', () => {
  const tx = {} as Parameters<typeof enqueueResourceLinkDeletions>[0]

  it('按各行的 s3_key 入删除出箱', async () => {
    await enqueueResourceLinkDeletions(tx, [{ s3Key: 'k-a' }, { s3Key: 'k-b' }])

    expect(enqueueS3DeletionMock).toHaveBeenCalledWith(tx, ['k-a', 'k-b'])
    expect(kunLog).not.toHaveBeenCalled()
  })

  it('没有 key 的行不入队, 记一条日志; 其余照常入队', async () => {
    await enqueueResourceLinkDeletions(tx, [
      { s3Key: '' },
      { s3Key: 'k-b' },
      { s3Key: '' }
    ])

    expect(enqueueS3DeletionMock).toHaveBeenCalledWith(tx, ['k-b'])
    expect(kunLog).toHaveBeenCalledExactlyOnceWith('s3.link_without_key', {
      count: 2
    })
  })

  it('只多带了地址与校验码的行也只认 s3_key, 不从它们拼 key', async () => {
    await enqueueResourceLinkDeletions(tx, [
      {
        s3Key: '',
        content: 'https://cdn.example/patch/10/resource/b3/game.zip',
        hash: 'b3'
      } as { s3Key: string }
    ])

    expect(enqueueS3DeletionMock).toHaveBeenCalledWith(tx, [])
  })
})
