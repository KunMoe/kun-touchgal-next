import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getMeiliClientMock,
  patchFindUniqueMock,
  outboxUpsertMock,
  outboxFindManyMock,
  outboxDeleteManyMock,
  addDocumentsMock,
  deleteDocumentMock,
  waitTaskMock,
  patchToSearchDocMock,
  withTaskLockMock
} = vi.hoisted(() => ({
  getMeiliClientMock: vi.fn(),
  patchFindUniqueMock: vi.fn(),
  outboxUpsertMock: vi.fn(),
  outboxFindManyMock: vi.fn(),
  outboxDeleteManyMock: vi.fn(),
  addDocumentsMock: vi.fn(),
  deleteDocumentMock: vi.fn(),
  waitTaskMock: vi.fn(),
  patchToSearchDocMock: vi.fn(),
  withTaskLockMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    patch: { findUnique: patchFindUniqueMock },
    search_outbox: {
      upsert: outboxUpsertMock,
      findMany: outboxFindManyMock,
      deleteMany: outboxDeleteManyMock
    }
  }
}))

vi.mock('~/lib/meilisearch', () => ({
  getMeiliClient: getMeiliClientMock
}))

vi.mock('~/server/search/document', () => ({
  PATCH_SEARCH_SELECT: {},
  patchToSearchDoc: patchToSearchDocMock
}))

// withTaskLock 直接执行传入的任务体，聚焦 drain 逻辑本身
vi.mock('~/server/tasks/withTaskLock', () => ({
  withTaskLock: withTaskLockMock
}))

import {
  syncPatchToSearch,
  drainSearchOutbox,
  queueSearchSync,
  queueSearchRemove,
  enqueueSearchOutbox,
  enqueueSearchOutboxBatch
} from '~/server/search/sync'

// setImmediate 在微任务队列排空后才触发，足以让 queue* 的 fire-and-forget 链
//（enqueue → kickDrain → drain）完全结算
const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  getMeiliClientMock.mockReset().mockReturnValue({
    index: () => ({
      addDocuments: addDocumentsMock,
      deleteDocument: deleteDocumentMock
    })
  })
  patchFindUniqueMock.mockReset()
  outboxUpsertMock.mockReset().mockResolvedValue(undefined)
  outboxFindManyMock.mockReset().mockResolvedValue([])
  outboxDeleteManyMock.mockReset().mockResolvedValue({ count: 1 })
  addDocumentsMock.mockReset().mockReturnValue({ waitTask: waitTaskMock })
  deleteDocumentMock.mockReset().mockReturnValue({ waitTask: waitTaskMock })
  waitTaskMock.mockReset().mockResolvedValue({ status: 'succeeded' })
  patchToSearchDocMock.mockReset().mockResolvedValue({ id: 1 })
  withTaskLockMock
    .mockReset()
    .mockImplementation(
      (_opts, task: (renew: () => Promise<void>) => Promise<unknown>) =>
        task(async () => {})
    )
})

describe('syncPatchToSearch 等待任务终态', () => {
  it('补丁存在时 addDocuments 并 waitTask，成功不抛错', async () => {
    patchFindUniqueMock.mockResolvedValue({ id: 1 })

    await syncPatchToSearch(1)

    expect(addDocumentsMock).toHaveBeenCalledWith([{ id: 1 }])
    expect(waitTaskMock).toHaveBeenCalledTimes(1)
    expect(deleteDocumentMock).not.toHaveBeenCalled()
  })

  it('补丁不存在时删除索引文档并 waitTask', async () => {
    patchFindUniqueMock.mockResolvedValue(null)

    await syncPatchToSearch(7)

    expect(deleteDocumentMock).toHaveBeenCalledWith(7)
    expect(waitTaskMock).toHaveBeenCalledTimes(1)
    expect(addDocumentsMock).not.toHaveBeenCalled()
  })

  it('任务终态非 succeeded 时抛错（静默失败不再被吞）', async () => {
    patchFindUniqueMock.mockResolvedValue({ id: 1 })
    waitTaskMock.mockResolvedValue({ status: 'failed', error: { code: 'x' } })

    await expect(syncPatchToSearch(1)).rejects.toThrow('同步 patch 1 失败')
  })

  it('删除任务终态非 succeeded 时抛错', async () => {
    patchFindUniqueMock.mockResolvedValue(null)
    waitTaskMock.mockResolvedValue({ status: 'failed', error: {} })

    await expect(syncPatchToSearch(7)).rejects.toThrow('删除 patch 7 失败')
  })

  it('未配置 Meili 时直接返回、不触库', async () => {
    getMeiliClientMock.mockReturnValue(null)

    await syncPatchToSearch(1)

    expect(patchFindUniqueMock).not.toHaveBeenCalled()
  })
})

describe('drainSearchOutbox 单消费者 + CAS 删除', () => {
  it('成功同步后按 (patch_id, seq) 条件删除写出箱行', async () => {
    outboxFindManyMock.mockResolvedValue([{ patch_id: 5, seq: 3 }])
    patchFindUniqueMock.mockResolvedValue({ id: 5 })

    await drainSearchOutbox()

    expect(waitTaskMock).toHaveBeenCalledTimes(1)
    expect(outboxDeleteManyMock).toHaveBeenCalledWith({
      where: { patch_id: 5, seq: 3 }
    })
  })

  it('一行失败不阻断其余行处理', async () => {
    outboxFindManyMock.mockResolvedValue([
      { patch_id: 5, seq: 1 },
      { patch_id: 6, seq: 1 }
    ])
    patchFindUniqueMock.mockResolvedValue({ id: 0 })
    waitTaskMock
      .mockResolvedValueOnce({ status: 'failed', error: {} })
      .mockResolvedValueOnce({ status: 'succeeded' })

    await drainSearchOutbox()

    expect(outboxDeleteManyMock).toHaveBeenCalledTimes(1)
    expect(outboxDeleteManyMock).toHaveBeenCalledWith({
      where: { patch_id: 6, seq: 1 }
    })
  })

  it('未配置 Meili 时不加锁、不查库', async () => {
    getMeiliClientMock.mockReturnValue(null)

    await drainSearchOutbox()

    expect(withTaskLockMock).not.toHaveBeenCalled()
    expect(outboxFindManyMock).not.toHaveBeenCalled()
  })
})

describe('queueSearchSync/Remove 入写出箱并即时消费', () => {
  it('入队 upsert 累加 seq，并触发即时 drain', async () => {
    queueSearchSync(9)
    await flush()

    expect(outboxUpsertMock).toHaveBeenCalledWith({
      where: { patch_id: 9 },
      create: { patch_id: 9 },
      update: { seq: { increment: 1 } }
    })
    // kick 触发了一次 drain（无行可处理）
    expect(withTaskLockMock).toHaveBeenCalledTimes(1)
  })

  it('删除路径同样只入队，由消费者据 DB 现状执行删除', async () => {
    queueSearchRemove(9)
    await flush()

    expect(outboxUpsertMock).toHaveBeenCalledWith({
      where: { patch_id: 9 },
      create: { patch_id: 9 },
      update: { seq: { increment: 1 } }
    })
  })

  it('未配置 Meili 时不入队', async () => {
    getMeiliClientMock.mockReturnValue(null)

    queueSearchSync(9)
    await flush()

    expect(outboxUpsertMock).not.toHaveBeenCalled()
  })
})

describe('enqueueSearchOutbox 事务性入队（C-full）', () => {
  it('对传入的 client（事务 tx）执行 upsert，而非顶层 prisma', async () => {
    const txUpsert = vi.fn().mockResolvedValue(undefined)
    const tx = { search_outbox: { upsert: txUpsert } } as never

    await enqueueSearchOutbox(tx, 42)

    expect(txUpsert).toHaveBeenCalledWith({
      where: { patch_id: 42 },
      create: { patch_id: 42 },
      update: { seq: { increment: 1 } }
    })
    // 未落到顶层 prisma：证明入队参与调用方事务、与补丁变更原子提交
    expect(outboxUpsertMock).not.toHaveBeenCalled()
  })
})

describe('enqueueSearchOutboxBatch 批量事务性入队', () => {
  it('对传入的 client 以单条 SQL 批量 upsert，冲突累加 seq', async () => {
    const txExecuteRaw = vi.fn().mockResolvedValue(2)
    const tx = { $executeRaw: txExecuteRaw } as never

    await enqueueSearchOutboxBatch(tx, [7, 3, 7])

    expect(txExecuteRaw).toHaveBeenCalledTimes(1)
    const [strings, ids] = txExecuteRaw.mock.calls[0]
    const sql = (strings as readonly string[]).join('?')
    expect(sql).toContain('INSERT INTO search_outbox')
    expect(sql).toContain('ON CONFLICT (patch_id)')
    expect(sql).toContain('seq = search_outbox.seq + 1')
    // 去重（重复 id 同语句二次命中同行报 21000）且升序（统一锁序防死锁）
    expect(ids).toEqual([3, 7])
  })

  it('空数组直接返回、不触库', async () => {
    const txExecuteRaw = vi.fn()
    const tx = { $executeRaw: txExecuteRaw } as never

    await enqueueSearchOutboxBatch(tx, [])

    expect(txExecuteRaw).not.toHaveBeenCalled()
  })
})
