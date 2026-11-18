import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  outboxFindManyMock,
  outboxDeleteManyMock,
  outboxUpdateManyMock,
  executeRawMock,
  deleteFileFromS3Mock,
  isS3ObjectReferencedMock,
  withTaskLockMock
} = vi.hoisted(() => ({
  outboxFindManyMock: vi.fn(),
  outboxDeleteManyMock: vi.fn(),
  outboxUpdateManyMock: vi.fn(),
  executeRawMock: vi.fn(),
  deleteFileFromS3Mock: vi.fn(),
  isS3ObjectReferencedMock: vi.fn(),
  withTaskLockMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    $executeRaw: executeRawMock,
    s3_deletion_outbox: {
      findMany: outboxFindManyMock,
      deleteMany: outboxDeleteManyMock,
      updateMany: outboxUpdateManyMock
    }
  }
}))

// 引用判定的 SQL 语义 (content 尾段、patch/1 与 patch/10 的边界) 由 s3Outbox.db.test.ts
// 在真实 PostgreSQL 上守护; 这里只测 drain 怎么用它的结论
vi.mock('~/server/storage/references', () => ({
  isS3ObjectReferenced: isS3ObjectReferencedMock
}))

vi.mock('~/lib/s3', () => ({
  deleteFileFromS3: deleteFileFromS3Mock
}))

// withTaskLock 直接执行传入的任务体，聚焦 drain 逻辑本身
vi.mock('~/server/tasks/withTaskLock', () => ({
  withTaskLock: withTaskLockMock
}))

import {
  enqueueS3Deletion,
  drainS3DeletionOutbox,
  kickS3DeletionDrain
} from '~/server/storage/s3Outbox'

// setImmediate 在微任务队列排空后触发，足以让 kick 的 fire-and-forget drain 结算
const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  outboxFindManyMock.mockReset().mockResolvedValue([])
  outboxDeleteManyMock.mockReset().mockResolvedValue({ count: 1 })
  outboxUpdateManyMock.mockReset().mockResolvedValue({ count: 1 })
  executeRawMock.mockReset().mockResolvedValue(0)
  deleteFileFromS3Mock.mockReset().mockResolvedValue(undefined)
  isS3ObjectReferencedMock.mockReset().mockResolvedValue(false)
  withTaskLockMock
    .mockReset()
    .mockImplementation(
      (_opts, task: (renew: () => Promise<void>) => Promise<unknown>) =>
        task(async () => {})
    )
})

describe('enqueueS3Deletion 事务性入队', () => {
  it('在传入的 client（事务 tx）上执行一条去重、排序后的 upsert', async () => {
    const txExecuteRaw = vi.fn().mockResolvedValue(2)
    const tx = { $executeRaw: txExecuteRaw } as never

    await enqueueS3Deletion(tx, ['b', 'a', 'b'])

    expect(txExecuteRaw).toHaveBeenCalledTimes(1)
    const [strings, keys] = txExecuteRaw.mock.calls[0]
    // 同语句重复 key 会报 21000; 排序统一锁序
    expect(keys).toEqual(['a', 'b'])
    // 重复入队递增认领令牌, 而不是 skipDuplicates 式的静默合并
    expect((strings as string[]).join('?')).toContain(
      'ON CONFLICT (s3_key) DO UPDATE'
    )
    expect((strings as string[]).join('?')).toContain(
      'seq = s3_deletion_outbox.seq + 1'
    )
    // 未落到顶层 prisma：证明入队参与调用方事务、与行删除原子提交
    expect(executeRawMock).not.toHaveBeenCalled()
  })

  it('空 keys 时不触库', async () => {
    const txExecuteRaw = vi.fn()
    const tx = { $executeRaw: txExecuteRaw } as never

    await enqueueS3Deletion(tx, [])

    expect(txExecuteRaw).not.toHaveBeenCalled()
  })
})

describe('drainS3DeletionOutbox 单消费者 + 引用判定 + CAS 删行', () => {
  it('无引用：删除对象后按 (s3_key, seq) 移除出箱行', async () => {
    outboxFindManyMock.mockResolvedValue([{ s3_key: 'k1', seq: 3 }])

    const result = await drainS3DeletionOutbox()

    expect(isS3ObjectReferencedMock).toHaveBeenCalledWith(
      expect.anything(),
      'k1'
    )
    expect(deleteFileFromS3Mock).toHaveBeenCalledWith('k1')
    expect(outboxDeleteManyMock).toHaveBeenCalledWith({
      where: { s3_key: 'k1', seq: 3 }
    })
    expect(outboxUpdateManyMock).not.toHaveBeenCalled()
    expect(result).toEqual({ deleted: 1, skippedReferenced: 0 })
  })

  it('仍被引用：不删对象，只按 (s3_key, seq) 移除出箱行并告警', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    outboxFindManyMock.mockResolvedValue([{ s3_key: 'shared', seq: 0 }])
    isS3ObjectReferencedMock.mockResolvedValue(true)

    const result = await drainS3DeletionOutbox()

    expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
    expect(outboxDeleteManyMock).toHaveBeenCalledWith({
      where: { s3_key: 'shared', seq: 0 }
    })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ deleted: 0, skippedReferenced: 1 })
    warn.mockRestore()
  })

  it('引用判定在删除之前：判定失败时既不删对象也不删行', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    outboxFindManyMock.mockResolvedValue([{ s3_key: 'k1', seq: 0 }])
    isS3ObjectReferencedMock.mockRejectedValue(new Error('db down'))

    await drainS3DeletionOutbox()

    expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
    expect(outboxDeleteManyMock).not.toHaveBeenCalled()
    expect(outboxUpdateManyMock).toHaveBeenCalledWith({
      where: { s3_key: 'k1' },
      data: { attempts: { increment: 1 } }
    })
    error.mockRestore()
  })

  it('删除失败的行不移除、累加 attempts 滞留待下一轮', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    outboxFindManyMock.mockResolvedValue([{ s3_key: 'k1', seq: 0 }])
    deleteFileFromS3Mock.mockRejectedValue(new Error('S3 down'))

    await drainS3DeletionOutbox()

    expect(outboxDeleteManyMock).not.toHaveBeenCalled()
    expect(outboxUpdateManyMock).toHaveBeenCalledWith({
      where: { s3_key: 'k1' },
      data: { attempts: { increment: 1 } }
    })
    error.mockRestore()
  })

  it('一行失败不阻断其余行处理', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    outboxFindManyMock.mockResolvedValue([
      { s3_key: 'k1', seq: 0 },
      { s3_key: 'k2', seq: 1 }
    ])
    deleteFileFromS3Mock
      .mockRejectedValueOnce(new Error('S3 down'))
      .mockResolvedValueOnce(undefined)

    await drainS3DeletionOutbox()

    expect(outboxDeleteManyMock).toHaveBeenCalledTimes(1)
    expect(outboxDeleteManyMock).toHaveBeenCalledWith({
      where: { s3_key: 'k2', seq: 1 }
    })
    error.mockRestore()
  })
})

describe('kickS3DeletionDrain 即时消费', () => {
  it('fire-and-forget 触发一次 drain', async () => {
    kickS3DeletionDrain()
    await flush()

    expect(withTaskLockMock).toHaveBeenCalledTimes(1)
  })
})
