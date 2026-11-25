import { beforeEach, describe, expect, it, vi } from 'vitest'

const { executeRawMock, checkoutMock, ackMock, ackEntriesMock } = vi.hoisted(
  () => ({
    executeRawMock: vi.fn(),
    checkoutMock: vi.fn(),
    ackMock: vi.fn(),
    ackEntriesMock: vi.fn()
  })
)

vi.mock('~/prisma', () => ({
  prisma: { $executeRaw: executeRawMock }
}))

// 仅用于让 Prisma.sql / Prisma.join 构造模板片段，不依赖真实 client runtime
vi.mock('~/prisma/generated/prisma/client', () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values
    }),
    join: (values: unknown[]) => values
  }
}))

vi.mock('~/app/api/patch/views/buffer', () => ({
  checkoutPatchViewBuffer: checkoutMock,
  acknowledgePatchViewBuffer: ackMock,
  acknowledgePatchViewBufferEntries: ackEntriesMock
}))

// flushPatchViewsTask 经作业层 (server/jobs/lease.ts) 间接 import ~/lib/redis，mock 掉避免真实连接
vi.mock('~/lib/redis', () => ({
  acquireKvLock: vi.fn(),
  releaseKvLock: vi.fn(),
  renewKvLock: vi.fn()
}))

import { flushPatchViews } from '~/server/tasks/flushPatchViewsTask'

const PENDING = 'kun:touchgal:views:buffer:pending'

const bufferOf = (entries: Record<string, string>) => ({
  key: PENDING,
  entries
})

describe('flushPatchViews 逐批 autocommit + 逐批 ack', () => {
  beforeEach(() => {
    executeRawMock.mockReset().mockResolvedValue(1)
    checkoutMock.mockReset()
    ackMock.mockReset().mockResolvedValue(undefined)
    ackEntriesMock.mockReset().mockResolvedValue(undefined)
  })

  it('缓冲为空时直接返回，不写库不 ack', async () => {
    checkoutMock.mockResolvedValue(null)

    await flushPatchViews()

    expect(executeRawMock).not.toHaveBeenCalled()
    expect(ackMock).not.toHaveBeenCalled()
    expect(ackEntriesMock).not.toHaveBeenCalled()
  })

  it('无有效条目（count 非有限/<=0）时整键清理且不写库', async () => {
    checkoutMock.mockResolvedValue(bufferOf({ a: '0', b: 'x', c: '-3' }))

    await flushPatchViews()

    expect(executeRawMock).not.toHaveBeenCalled()
    expect(ackEntriesMock).not.toHaveBeenCalled()
    expect(ackMock).toHaveBeenCalledTimes(1)
    expect(ackMock).toHaveBeenCalledWith(PENDING)
  })

  it('单批：先写库后逐批 ack，末尾整键清理', async () => {
    checkoutMock.mockResolvedValue(bufferOf({ a: '2', b: '5' }))

    await flushPatchViews()

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    expect(ackEntriesMock).toHaveBeenCalledTimes(1)
    expect(ackEntriesMock).toHaveBeenCalledWith(PENDING, ['a', 'b'])
    expect(ackMock).toHaveBeenCalledTimes(1)
    expect(ackMock).toHaveBeenCalledWith(PENDING)
    // 顺序契约：UPDATE 提交在 HDEL 之前（崩溃至多过计一批，绝不丢计）
    expect(executeRawMock.mock.invocationCallOrder[0]).toBeLessThan(
      ackEntriesMock.mock.invocationCallOrder[0]
    )
  })

  it('跨批：>1000 条分多批，逐批写库 + 逐批 ack', async () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < 1001; i++) {
      entries[`id${i}`] = '1'
    }
    checkoutMock.mockResolvedValue(bufferOf(entries))

    await flushPatchViews()

    expect(executeRawMock).toHaveBeenCalledTimes(2)
    expect(ackEntriesMock).toHaveBeenCalledTimes(2)
    expect(ackEntriesMock.mock.calls[0][1]).toHaveLength(1000)
    expect(ackEntriesMock.mock.calls[1][1]).toHaveLength(1)
    expect(ackMock).toHaveBeenCalledTimes(1)
  })

  it('某批写库失败：已成功批已 ack，失败批与整键清理不执行，错误抛出', async () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < 1001; i++) {
      entries[`id${i}`] = '1'
    }
    checkoutMock.mockResolvedValue(bufferOf(entries))
    executeRawMock
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('db boom'))

    await expect(flushPatchViews()).rejects.toThrow('db boom')

    // 第 1 批已从 pending 摘除 → 重试不会重放已落库批次
    expect(ackEntriesMock).toHaveBeenCalledTimes(1)
    expect(ackEntriesMock.mock.calls[0][1]).toHaveLength(1000)
    // 整键清理未执行 → pending 保留失败批，下一 tick 重试
    expect(ackMock).not.toHaveBeenCalled()
  })

  // 租约丢了还接着落, 接手的进程会把同一批再计一次
  it('signal 中止 (关停、租约丢失) 时停在两批之间: 没落的批留在 pending, 抛出中止原因', async () => {
    const entries: Record<string, string> = {}
    for (let i = 0; i < 1001; i++) {
      entries[`id${i}`] = '1'
    }
    checkoutMock.mockResolvedValue(bufferOf(entries))
    const controller = new AbortController()
    const reason = new Error('lease lost')
    executeRawMock.mockImplementationOnce(async () => {
      controller.abort(reason)
      return 1
    })

    await expect(flushPatchViews(controller.signal)).rejects.toBe(reason)

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    expect(ackEntriesMock).toHaveBeenCalledTimes(1)
    expect(ackMock).not.toHaveBeenCalled()
  })
})
