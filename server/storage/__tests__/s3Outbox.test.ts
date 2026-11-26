import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  outboxFindManyMock,
  outboxDeleteManyMock,
  outboxUpdateManyMock,
  executeRawMock,
  deleteFileFromS3Mock,
  isS3ObjectReferencedMock,
  withJobLeaseMock
} = vi.hoisted(() => ({
  outboxFindManyMock: vi.fn(),
  outboxDeleteManyMock: vi.fn(),
  outboxUpdateManyMock: vi.fn(),
  executeRawMock: vi.fn(),
  deleteFileFromS3Mock: vi.fn(),
  isS3ObjectReferencedMock: vi.fn(),
  withJobLeaseMock: vi.fn()
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

// 租约直接执行传入的任务体，聚焦 drain 逻辑本身; 用例可以中止 lease 模拟租约丢失
vi.mock('~/server/jobs/lease', () => ({
  withJobLease: withJobLeaseMock
}))

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import {
  enqueueS3Deletion,
  drainS3DeletionOutbox,
  kickS3DeletionDrain
} from '~/server/storage/s3Outbox'

// setImmediate 在微任务队列排空后触发，足以让 kick 的 fire-and-forget drain 结算
const flush = () => new Promise((resolve) => setImmediate(resolve))

let lease: AbortController
const progressMock = vi.fn()

beforeEach(() => {
  vi.mocked(kunLog).mockReset()
  outboxFindManyMock.mockReset().mockResolvedValue([])
  outboxDeleteManyMock.mockReset().mockResolvedValue({ count: 1 })
  outboxUpdateManyMock.mockReset().mockResolvedValue({ count: 1 })
  executeRawMock.mockReset().mockResolvedValue(0)
  deleteFileFromS3Mock.mockReset().mockResolvedValue(undefined)
  isS3ObjectReferencedMock.mockReset().mockResolvedValue(false)
  lease = new AbortController()
  withJobLeaseMock
    .mockReset()
    .mockImplementation(
      async (
        _spec,
        fn: (held: {
          signal: AbortSignal
          progress: () => void
        }) => Promise<unknown>
      ) => ({
        ran: true,
        value: await fn({ signal: lease.signal, progress: progressMock })
      })
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
      "seq = nextval(pg_get_serial_sequence('s3_deletion_outbox', 'seq'))"
    )
    // 未落到顶层 prisma：证明入队参与调用方事务、与行删除原子提交
    expect(executeRawMock).not.toHaveBeenCalled()
  })

  it('不传 delayMs 时时刻参数为 NULL (立即); 传了就按毫秒交给库算, 合并取更早、立即优先', async () => {
    const txExecuteRaw = vi.fn().mockResolvedValue(1)
    const tx = { $executeRaw: txExecuteRaw } as never

    await enqueueS3Deletion(tx, ['a'])
    await enqueueS3Deletion(tx, ['a'], { delayMs: 86_400_000 })

    expect(txExecuteRaw.mock.calls[0][2]).toBeNull()
    expect(txExecuteRaw.mock.calls[1][2]).toBe(86_400_000)
    const sql = (txExecuteRaw.mock.calls[1][0] as string[]).join('?')
    expect(sql).toContain(
      "(now() AT TIME ZONE 'UTC') + ?::bigint * interval '1 millisecond'"
    )
    expect(sql).toContain(
      'ELSE LEAST(s3_deletion_outbox.not_before, EXCLUDED.not_before)'
    )
  })

  it('空 keys 时不触库', async () => {
    const txExecuteRaw = vi.fn()
    const tx = { $executeRaw: txExecuteRaw } as never

    await enqueueS3Deletion(tx, [])

    expect(txExecuteRaw).not.toHaveBeenCalled()
  })
})

describe('drainS3DeletionOutbox 单消费者 + 引用判定 + CAS 删行', () => {
  it('只取立即或已到时刻的行 (not_before 为 NULL 或不晚于本轮开始的时刻)', async () => {
    await drainS3DeletionOutbox()

    const [args] = outboxFindManyMock.mock.calls[0]
    expect(args.where).toEqual({
      OR: [{ not_before: null }, { not_before: { lte: expect.any(Date) } }]
    })
  })

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
    outboxFindManyMock.mockResolvedValue([{ s3_key: 'shared', seq: 0 }])
    isS3ObjectReferencedMock.mockResolvedValue(true)

    const result = await drainS3DeletionOutbox()

    expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
    expect(outboxDeleteManyMock).toHaveBeenCalledWith({
      where: { s3_key: 'shared', seq: 0 }
    })
    expect(kunLog).toHaveBeenCalledExactlyOnceWith('s3.outbox_row_skipped', {
      key: 'shared'
    })
    expect(result).toEqual({ deleted: 0, skippedReferenced: 1 })
  })

  it('引用判定在删除之前：判定失败时既不删对象也不删行', async () => {
    outboxFindManyMock.mockResolvedValue([{ s3_key: 'k1', seq: 0 }])
    isS3ObjectReferencedMock.mockRejectedValue(new Error('db down'))

    await drainS3DeletionOutbox()

    expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
    expect(outboxDeleteManyMock).not.toHaveBeenCalled()
    expect(outboxUpdateManyMock).toHaveBeenCalledWith({
      where: { s3_key: 'k1' },
      data: { attempts: { increment: 1 } }
    })
  })

  it('删除失败的行不移除、累加 attempts 滞留待下一轮', async () => {
    const error = new Error('S3 down')
    outboxFindManyMock.mockResolvedValue([{ s3_key: 'k1', seq: 0 }])
    deleteFileFromS3Mock.mockRejectedValue(error)

    await drainS3DeletionOutbox()

    expect(outboxDeleteManyMock).not.toHaveBeenCalled()
    expect(outboxUpdateManyMock).toHaveBeenCalledWith({
      where: { s3_key: 'k1' },
      data: { attempts: { increment: 1 } }
    })
    expect(kunLog).toHaveBeenCalledExactlyOnceWith(
      's3.outbox_row_failed',
      { key: 'k1' },
      error
    )
  })

  it('每处理完一行报一次进度 (租约的停滞看门狗), 失败的行也算', async () => {
    progressMock.mockClear()
    outboxFindManyMock.mockResolvedValue([
      { s3_key: 'k1', seq: 0 },
      { s3_key: 'k2', seq: 1 }
    ])
    deleteFileFromS3Mock.mockRejectedValueOnce(new Error('S3 down'))

    await drainS3DeletionOutbox()

    expect(progressMock).toHaveBeenCalledTimes(2)
  })

  it('一行失败不阻断其余行处理', async () => {
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
  })

  it('租约丢失或关停 (lease.signal 中止) 时在下一行之前停下, 剩下的行留在出箱', async () => {
    outboxFindManyMock.mockResolvedValue([
      { s3_key: 'k1', seq: 0 },
      { s3_key: 'k2', seq: 1 }
    ])
    deleteFileFromS3Mock.mockImplementationOnce(async () => {
      lease.abort(new Error('lease lost'))
    })

    const result = await drainS3DeletionOutbox()

    expect(deleteFileFromS3Mock).toHaveBeenCalledExactlyOnceWith('k1')
    expect(outboxDeleteManyMock).toHaveBeenCalledExactlyOnceWith({
      where: { s3_key: 'k1', seq: 0 }
    })
    expect(result).toEqual({ deleted: 1, skippedReferenced: 0 })
  })

  it('调用方的 signal 交给租约; 抢不到锁时返回 undefined', async () => {
    const controller = new AbortController()
    withJobLeaseMock.mockResolvedValueOnce({ ran: false })

    await expect(
      drainS3DeletionOutbox({ signal: controller.signal })
    ).resolves.toBeUndefined()
    expect(withJobLeaseMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        key: 's3:deletion:outbox:lock',
        signal: controller.signal
      }),
      expect.any(Function)
    )
    expect(outboxFindManyMock).not.toHaveBeenCalled()
  })
})

describe('kickS3DeletionDrain 即时消费', () => {
  it('fire-and-forget 触发一次 drain', async () => {
    kickS3DeletionDrain()
    await flush()

    expect(withJobLeaseMock).toHaveBeenCalledTimes(1)
  })
})
