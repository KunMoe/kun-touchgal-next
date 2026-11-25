import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { meiliApiError, meiliDown } from './meiliErrors'

const {
  getMeiliClientMock,
  patchFindUniqueMock,
  executeRawMock,
  outboxFindManyMock,
  outboxDeleteManyMock,
  outboxUpdateManyMock,
  addDocumentsMock,
  deleteDocumentMock,
  updateDocumentsMock,
  waitTaskMock,
  patchToSearchDocMock,
  withJobLeaseMock,
  outboxCountMock
} = vi.hoisted(() => ({
  getMeiliClientMock: vi.fn(),
  patchFindUniqueMock: vi.fn(),
  executeRawMock: vi.fn(),
  outboxFindManyMock: vi.fn(),
  outboxDeleteManyMock: vi.fn(),
  outboxUpdateManyMock: vi.fn(),
  addDocumentsMock: vi.fn(),
  deleteDocumentMock: vi.fn(),
  updateDocumentsMock: vi.fn(),
  waitTaskMock: vi.fn(),
  patchToSearchDocMock: vi.fn(),
  withJobLeaseMock: vi.fn(),
  outboxCountMock: vi.fn()
}))

vi.mock('~/prisma/index', () => ({
  prisma: {
    $executeRaw: executeRawMock,
    patch: { findUnique: patchFindUniqueMock },
    search_outbox: {
      findMany: outboxFindManyMock,
      deleteMany: outboxDeleteManyMock,
      updateMany: outboxUpdateManyMock,
      count: outboxCountMock
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

// 租约直接执行传入的任务体，聚焦 drain 逻辑本身; 用例可以中止 lease 模拟租约丢失
vi.mock('~/server/jobs/lease', () => ({
  withJobLease: withJobLeaseMock
}))

import {
  SEARCH_OUTBOX_MAX_ATTEMPTS,
  syncPatchToSearch,
  drainSearchOutbox,
  queueSearchSync,
  queueSearchRemove,
  enqueueSearchOutbox,
  enqueueSearchOutboxBatch,
  withSearchWriter,
  drainSearchOutboxUntilEmpty,
  getSearchOutboxBacklog
} from '~/server/search/sync'

// setImmediate 在微任务队列排空后才触发，足以让 queue* 的 fire-and-forget 链
//（enqueue → kickDrain → drain）完全结算
const flush = () => new Promise((resolve) => setImmediate(resolve))

const MINUTE = 60_000

// 出箱里待取的一行
const row = (patchId: number, seq = 1, attempts = 0) => ({
  patch_id: patchId,
  seq,
  attempts
})

// 一行的 waitTask 终态: 文档本身被拒
const rejectedTask = {
  status: 'failed',
  error: { code: 'invalid_document_fields', type: 'invalid_request' }
}

let errorSpy: ReturnType<typeof vi.spyOn>
let lease: AbortController
const progressMock = vi.fn()

beforeEach(() => {
  getMeiliClientMock.mockReset().mockReturnValue({
    index: () => ({
      addDocuments: addDocumentsMock,
      deleteDocument: deleteDocumentMock,
      updateDocuments: updateDocumentsMock
    })
  })
  patchFindUniqueMock.mockReset().mockResolvedValue({ id: 1 })
  executeRawMock.mockReset().mockResolvedValue(1)
  outboxFindManyMock.mockReset().mockResolvedValue([])
  outboxDeleteManyMock.mockReset().mockResolvedValue({ count: 1 })
  outboxUpdateManyMock.mockReset().mockResolvedValue({ count: 1 })
  addDocumentsMock.mockReset().mockReturnValue({ waitTask: waitTaskMock })
  deleteDocumentMock.mockReset().mockReturnValue({ waitTask: waitTaskMock })
  updateDocumentsMock.mockReset().mockReturnValue({ waitTask: waitTaskMock })
  waitTaskMock.mockReset().mockResolvedValue({ status: 'succeeded' })
  patchToSearchDocMock.mockReset().mockResolvedValue({ id: 1 })
  outboxCountMock.mockReset().mockResolvedValue(0)
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
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('syncPatchToSearch 等待任务终态', () => {
  it('补丁存在时 addDocuments 并 waitTask，成功不抛错', async () => {
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
    outboxFindManyMock.mockResolvedValueOnce([row(5, 3)])

    const result = await drainSearchOutbox()

    expect(waitTaskMock).toHaveBeenCalledTimes(1)
    expect(outboxDeleteManyMock).toHaveBeenCalledWith({
      where: { patch_id: 5, seq: 3 }
    })
    expect(result).toEqual({ outcome: 'drained', synced: 1, failed: 0 })
  })

  it('只取没隔离、退避已到期的行，按入队先后', async () => {
    await drainSearchOutbox()

    const { where, orderBy } = outboxFindManyMock.mock.calls[0][0]
    expect(where.attempts).toEqual({ lt: SEARCH_OUTBOX_MAX_ATTEMPTS })
    expect(where.OR[0]).toEqual({ next_attempt_at: null })
    expect(where.OR[1].next_attempt_at.lte).toBeInstanceOf(Date)
    expect(orderBy).toEqual({ updated: 'asc' })
  })

  it('每处理完一行报一次进度 (写锁的停滞看门狗), 被拒的行也算', async () => {
    progressMock.mockClear()
    outboxFindManyMock.mockResolvedValueOnce([row(5), row(6)])
    waitTaskMock
      .mockResolvedValueOnce(rejectedTask)
      .mockResolvedValueOnce({ status: 'succeeded' })

    await drainSearchOutbox()

    expect(progressMock).toHaveBeenCalledTimes(2)
  })

  it('一行被拒不阻断其余行处理', async () => {
    outboxFindManyMock.mockResolvedValueOnce([row(5), row(6)])
    waitTaskMock
      .mockResolvedValueOnce(rejectedTask)
      .mockResolvedValueOnce({ status: 'succeeded' })

    const result = await drainSearchOutbox()

    expect(outboxDeleteManyMock).toHaveBeenCalledTimes(1)
    expect(outboxDeleteManyMock).toHaveBeenCalledWith({
      where: { patch_id: 6, seq: 1 }
    })
    expect(result).toEqual({ outcome: 'drained', synced: 1, failed: 1 })
  })

  // 租约丢了还接着写, 另一个写者可能已经开始, 两边按任务入队的先后写乱
  it('写锁丢失 (租约 signal 中止) 时在下一行之前停下, 手上这一行写完', async () => {
    outboxFindManyMock.mockResolvedValueOnce([row(1), row(2), row(3)])
    waitTaskMock.mockImplementationOnce(async () => {
      lease.abort(new Error('lease lost'))
      return { status: 'succeeded' }
    })

    const result = await drainSearchOutbox({ budgetMs: 50_000 })

    expect(result).toEqual({ outcome: 'paused', synced: 1, failed: 0 })
    expect(addDocumentsMock).toHaveBeenCalledTimes(1)
    expect(outboxDeleteManyMock).toHaveBeenCalledExactlyOnceWith({
      where: { patch_id: 1, seq: 1 }
    })
  })

  it('调用方的 signal 交给租约: cron 进程关停时不再等锁、已在写的停在下一行之前', async () => {
    const controller = new AbortController()

    await drainSearchOutbox({ budgetMs: 50_000, signal: controller.signal })

    expect(withJobLeaseMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        key: 'search:outbox:lock',
        signal: controller.signal
      }),
      expect.any(Function)
    )
  })

  it('不传预算只跑一批: 满批之后不再取下一批', async () => {
    outboxFindManyMock.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => row(i + 1))
    )

    const result = await drainSearchOutbox()

    expect(outboxFindManyMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ outcome: 'paused', synced: 200, failed: 0 })
  })

  it('带预算时连续取批，直到取到不满一批', async () => {
    outboxFindManyMock
      .mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => row(i + 1)))
      .mockResolvedValueOnce([row(201)])

    const result = await drainSearchOutbox({ budgetMs: 50_000 })

    expect(outboxFindManyMock).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ outcome: 'drained', synced: 201, failed: 0 })
  })

  it('预算用完时在行与行之间停下，剩下的留给下一轮', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    outboxFindManyMock.mockResolvedValueOnce([row(1), row(2), row(3)])
    waitTaskMock.mockImplementation(async () => {
      now += 30_000
      return { status: 'succeeded' }
    })

    const result = await drainSearchOutbox({ budgetMs: 50_000 })

    expect(result).toEqual({ outcome: 'paused', synced: 2, failed: 0 })
    expect(outboxDeleteManyMock).toHaveBeenCalledTimes(2)
  })

  it('写锁在别的写者手里时什么都不做', async () => {
    withJobLeaseMock.mockResolvedValue({ ran: false })

    expect(await drainSearchOutbox()).toEqual({
      outcome: 'locked',
      synced: 0,
      failed: 0
    })
    expect(outboxFindManyMock).not.toHaveBeenCalled()
  })

  it('未配置 Meili 时不加锁、不查库', async () => {
    getMeiliClientMock.mockReturnValue(null)

    expect((await drainSearchOutbox()).outcome).toBe('disabled')
    expect(withJobLeaseMock).not.toHaveBeenCalled()
    expect(outboxFindManyMock).not.toHaveBeenCalled()
  })
})

describe('drainSearchOutbox 失败记账', () => {
  it('文档被拒: 按 (patch_id, seq) 条件更新, attempts 加 1, 按次数退避, 记原因', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    outboxFindManyMock.mockResolvedValueOnce([row(5, 3, 2)])
    waitTaskMock.mockResolvedValue(rejectedTask)

    await drainSearchOutbox()

    expect(outboxUpdateManyMock).toHaveBeenCalledTimes(1)
    const { where, data } = outboxUpdateManyMock.mock.calls[0][0]
    expect(where).toEqual({ patch_id: 5, seq: 3 })
    expect(data.attempts).toBe(3)
    // 第 3 次失败之后等 2^2 分钟
    expect(data.next_attempt_at).toEqual(new Date(1_000_000 + 4 * MINUTE))
    expect(data.last_error).toContain('invalid_document_fields')
    expect(outboxDeleteManyMock).not.toHaveBeenCalled()
  })

  it('退避封顶 6 小时，第 10 次失败之后隔离', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    outboxFindManyMock.mockResolvedValueOnce([row(5, 3, 9)])
    waitTaskMock.mockResolvedValue(rejectedTask)

    await drainSearchOutbox()

    const { data } = outboxUpdateManyMock.mock.calls[0][0]
    expect(data.attempts).toBe(SEARCH_OUTBOX_MAX_ATTEMPTS)
    expect(data.next_attempt_at).toEqual(new Date(1_000_000 + 360 * MINUTE))
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('已隔离'),
      expect.any(String)
    )
  })

  it('last_error 按码点截到列宽 1007, 不在代理对中间切开', async () => {
    outboxFindManyMock.mockResolvedValueOnce([row(5)])
    patchToSearchDocMock.mockRejectedValue(new Error('😀'.repeat(2000)))

    await drainSearchOutbox()

    const { last_error: lastError } = outboxUpdateManyMock.mock.calls[0][0].data
    expect([...lastError]).toHaveLength(1007)
    expect(lastError.isWellFormed()).toBe(true)
  })

  it('构建文档时抛出的未知错误算在这一行头上, 继续处理下一行', async () => {
    outboxFindManyMock.mockResolvedValueOnce([row(5), row(6)])
    patchToSearchDocMock
      .mockRejectedValueOnce(new TypeError('boom'))
      .mockResolvedValueOnce({ id: 6 })

    const result = await drainSearchOutbox()

    expect(outboxUpdateManyMock).toHaveBeenCalledTimes(1)
    expect(outboxUpdateManyMock.mock.calls[0][0].where.patch_id).toBe(5)
    expect(result).toEqual({ outcome: 'drained', synced: 1, failed: 1 })
  })

  it.each([
    ['连不上 (MeilisearchRequestError)', () => meiliDown()],
    ['5xx', () => meiliApiError(503, 'internal')],
    ['429', () => meiliApiError(429, 'too_many_requests')],
    ['密钥不对 (403)', () => meiliApiError(403, 'invalid_api_key')],
    [
      '任务等待超时',
      () =>
        Object.assign(new Error('timeout'), {
          name: 'MeilisearchTaskTimeOutError'
        })
    ],
    [
      '应答不是 Meilisearch 的 (2xx 但正文不是 JSON)',
      () => new SyntaxError('Unexpected token <')
    ]
  ])(
    '引擎整体收不了写入 (%s): 不计次数、不删行, 这一行往后挪一分钟, 本轮在这一行处结束',
    async (_name, makeError) => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
      outboxFindManyMock.mockResolvedValueOnce([row(5, 3, 2), row(6)])
      addDocumentsMock.mockImplementationOnce(() => {
        throw makeError()
      })

      const result = await drainSearchOutbox({ budgetMs: 50_000 })

      expect(result).toEqual({
        outcome: 'engine-unavailable',
        synced: 0,
        failed: 0
      })
      // 只挪开, 不计次数、不记原因: 失败若其实只属于这份文档, 它也不会一直顶在队头
      expect(outboxUpdateManyMock).toHaveBeenCalledTimes(1)
      expect(outboxUpdateManyMock).toHaveBeenCalledWith({
        where: { patch_id: 5, seq: 3 },
        data: { next_attempt_at: new Date(1_000_000 + MINUTE) }
      })
      expect(outboxDeleteManyMock).not.toHaveBeenCalled()
      expect(addDocumentsMock).toHaveBeenCalledTimes(1)
      expect(outboxFindManyMock).toHaveBeenCalledTimes(1)
    }
  )

  it('处理期间又有新的入队 (CAS 没命中): 不说成第 N 次失败', async () => {
    outboxFindManyMock.mockResolvedValueOnce([row(5, 3, 9)])
    waitTaskMock.mockResolvedValue(rejectedTask)
    outboxUpdateManyMock.mockResolvedValue({ count: 0 })

    await drainSearchOutbox()

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('处理期间又有新的入队, 这次不计'),
      expect.any(String)
    )
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('已隔离'),
      expect.any(String)
    )
  })

  it.each([
    ['system', 'no_space_left_on_device'],
    ['internal', 'internal'],
    ['invalid_request', 'index_not_found']
  ])('任务失败但错误说的是引擎 (%s / %s): 不计次数', async (type, code) => {
    outboxFindManyMock.mockResolvedValueOnce([row(5)])
    waitTaskMock.mockResolvedValue({ status: 'failed', error: { type, code } })

    expect((await drainSearchOutbox()).outcome).toBe('engine-unavailable')
    expect(outboxUpdateManyMock.mock.calls[0][0].data).not.toHaveProperty(
      'attempts'
    )
  })

  it('请求体被拒 (400 malformed_payload) 算这一份文档的', async () => {
    outboxFindManyMock.mockResolvedValueOnce([row(5)])
    addDocumentsMock.mockImplementationOnce(() => {
      throw meiliApiError(400, 'malformed_payload')
    })

    expect((await drainSearchOutbox()).outcome).toBe('drained')
    expect(outboxUpdateManyMock).toHaveBeenCalledTimes(1)
  })
})

describe('queueSearchSync/Remove 入写出箱并即时消费', () => {
  it('入队 upsert 换发 seq，并触发即时 drain', async () => {
    queueSearchSync(9)
    await flush()

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    expect(executeRawMock.mock.calls[0][1]).toEqual([9])
    // kick 触发了一次 drain（无行可处理）
    expect(withJobLeaseMock).toHaveBeenCalledTimes(1)
  })

  it('即时 kick 只连续消费约 2 秒: 积压时不在请求进程里跑整批', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    outboxFindManyMock.mockResolvedValueOnce([row(1), row(2), row(3)])
    waitTaskMock.mockImplementation(async () => {
      now += 1500
      return { status: 'succeeded' }
    })

    queueSearchSync(9)
    await vi.waitFor(() => expect(outboxDeleteManyMock).toHaveBeenCalled())
    await flush()

    expect(outboxDeleteManyMock).toHaveBeenCalledTimes(2)
  })

  it('删除路径同样只入队，由消费者据 DB 现状执行删除', async () => {
    queueSearchRemove(9)
    await flush()

    expect(executeRawMock).toHaveBeenCalledTimes(1)
    expect(executeRawMock.mock.calls[0][1]).toEqual([9])
  })

  it('未配置 Meili 时不入队', async () => {
    getMeiliClientMock.mockReturnValue(null)

    queueSearchSync(9)
    await flush()

    expect(executeRawMock).not.toHaveBeenCalled()
  })
})

describe('enqueueSearchOutbox 事务性入队（C-full）', () => {
  it('对传入的 client（事务 tx）执行 upsert，而非顶层 prisma', async () => {
    const txExecuteRaw = vi.fn().mockResolvedValue(1)
    const tx = { $executeRaw: txExecuteRaw } as never

    await enqueueSearchOutbox(tx, 42)

    // 与批量入队同一条语句：冲突时同样从序列换发 seq
    expect(txExecuteRaw).toHaveBeenCalledTimes(1)
    expect(txExecuteRaw.mock.calls[0][1]).toEqual([42])
    // 未落到顶层 prisma：证明入队参与调用方事务、与补丁变更原子提交
    expect(executeRawMock).not.toHaveBeenCalled()
  })
})

describe('enqueueSearchOutboxBatch 批量事务性入队', () => {
  const sqlOf = (txExecuteRaw: ReturnType<typeof vi.fn>) =>
    (txExecuteRaw.mock.calls[0][0] as readonly string[]).join('?')

  it('对传入的 client 以单条 SQL 批量 upsert，冲突从序列换发 seq', async () => {
    const txExecuteRaw = vi.fn().mockResolvedValue(2)
    const tx = { $executeRaw: txExecuteRaw } as never

    await enqueueSearchOutboxBatch(tx, [7, 3, 7])

    expect(txExecuteRaw).toHaveBeenCalledTimes(1)
    const sql = sqlOf(txExecuteRaw)
    expect(sql).toContain('INSERT INTO search_outbox')
    expect(sql).toContain('ON CONFLICT (patch_id)')
    expect(sql).toContain(
      "seq = nextval(pg_get_serial_sequence('search_outbox', 'seq'))"
    )
    // 去重（重复 id 同语句二次命中同行报 21000）且升序（统一锁序防死锁）
    expect(txExecuteRaw.mock.calls[0][1]).toEqual([3, 7])
  })

  it('应用写入 (默认) 复位失败记录: 内容变了, 被拒的那一版可能已经修好', async () => {
    const txExecuteRaw = vi.fn().mockResolvedValue(1)

    await enqueueSearchOutboxBatch({ $executeRaw: txExecuteRaw } as never, [1])

    const sql = sqlOf(txExecuteRaw)
    expect(sql).toContain('attempts = 0')
    expect(sql).toContain('next_attempt_at = NULL')
    expect(sql).toContain('last_error = NULL')
  })

  it('对账入队只换发 seq, 不复位已退避 / 隔离的行', async () => {
    const txExecuteRaw = vi.fn().mockResolvedValue(1)

    await enqueueSearchOutboxBatch(
      { $executeRaw: txExecuteRaw } as never,
      [1],
      { mode: 'reconcile' }
    )

    const sql = sqlOf(txExecuteRaw)
    expect(sql).toContain(
      "seq = nextval(pg_get_serial_sequence('search_outbox', 'seq'))"
    )
    expect(sql).not.toMatch(/attempts|next_attempt_at|last_error/)
  })

  it('空数组直接返回、不触库', async () => {
    const txExecuteRaw = vi.fn()
    const tx = { $executeRaw: txExecuteRaw } as never

    await enqueueSearchOutboxBatch(tx, [])

    expect(txExecuteRaw).not.toHaveBeenCalled()
  })
})

describe('withSearchWriter 的 applyCounts', () => {
  const counts = (id: number) => ({
    id,
    view: 1,
    download: 1,
    favoriteCount: 1,
    resourceCount: 1,
    commentCount: 1,
    ratingCount: 1,
    avgRating: 1
  })

  it('与 drain 共用一把写锁', async () => {
    await withSearchWriter('t', async () => {})
    await drainSearchOutbox()

    const keys = withJobLeaseMock.mock.calls.map(([spec]) => spec.key)
    expect(keys).toEqual(['search:outbox:lock', 'search:outbox:lock'])
  })

  it('剔除出箱里还挂着行的 id, 只写其余的并返回它们', async () => {
    outboxFindManyMock.mockResolvedValueOnce([{ patch_id: 2 }])

    const applied = await withSearchWriter('t', ({ applyCounts }) =>
      applyCounts([counts(1), counts(2), counts(3)])
    )

    expect(outboxFindManyMock.mock.calls[0][0].where).toEqual({
      patch_id: { in: [1, 2, 3] }
    })
    expect(updateDocumentsMock).toHaveBeenCalledWith([counts(1), counts(3)])
    expect(applied).toEqual([counts(1), counts(3)])
  })

  it('全部被剔除或没有待写时不调 Meilisearch', async () => {
    outboxFindManyMock.mockResolvedValueOnce([{ patch_id: 1 }])

    await withSearchWriter('t', async ({ applyCounts }) => {
      expect(await applyCounts([counts(1)])).toEqual([])
      expect(await applyCounts([])).toEqual([])
    })

    expect(updateDocumentsMock).not.toHaveBeenCalled()
  })

  it('锁被占着时最多等多久由调用方给, 默认不等', async () => {
    await withSearchWriter('t', async () => {})
    await withSearchWriter('t', async () => {}, { waitMs: 90_000 })

    expect(withJobLeaseMock.mock.calls.map(([spec]) => spec.waitMs)).toEqual([
      0, 90_000
    ])
  })

  // 写锁丢失或关停时写者停在下一段之前: 手上这一段 (单文档、计数批次) 等任务终态的时间要有界
  it('等任务终态都带上限, 不超过一分钟', async () => {
    outboxFindManyMock.mockResolvedValueOnce([row(1)])
    await drainSearchOutbox()
    await withSearchWriter('t', ({ applyCounts }) => applyCounts([counts(1)]))

    const timeouts = waitTaskMock.mock.calls.map(([opts]) => opts.timeout)
    expect(timeouts).toHaveLength(2)
    for (const timeout of timeouts) {
      expect(timeout).toBeGreaterThan(0)
      expect(timeout).toBeLessThanOrEqual(60_000)
    }
  })

  it('计数批次任务失败时抛错', async () => {
    waitTaskMock.mockResolvedValue({ status: 'failed', error: { code: 'x' } })

    await expect(
      withSearchWriter('t', ({ applyCounts }) => applyCounts([counts(1)]))
    ).rejects.toThrow('计数快照批次写入失败')
  })
})

describe('getSearchOutboxBacklog', () => {
  it('可取的不含已隔离与退避未到期的行', async () => {
    outboxFindManyMock.mockResolvedValue([])

    await getSearchOutboxBacklog()

    const [ready, backoff] = outboxCountMock.mock.calls.map(
      ([args]) => args.where
    )
    expect(ready.attempts).toEqual({ lt: SEARCH_OUTBOX_MAX_ATTEMPTS })
    expect(ready.OR[0]).toEqual({ next_attempt_at: null })
    expect(ready.OR[1].next_attempt_at.lte).toBeInstanceOf(Date)
    expect(backoff.next_attempt_at.gt).toBeInstanceOf(Date)
    expect(outboxFindManyMock.mock.calls[0][0].where).toEqual({
      attempts: { gte: SEARCH_OUTBOX_MAX_ATTEMPTS }
    })
  })
})

describe('drainSearchOutboxUntilEmpty 对账命令的排空循环', () => {
  // 可取行数依次为给定的值 (每轮之后查一次)
  const readyAfterRounds = (...counts: number[]) => {
    for (const count of counts) {
      outboxCountMock
        .mockResolvedValueOnce(count) // ready
        .mockResolvedValueOnce(0) // backoff
    }
  }

  it('可取的行取完就返回', async () => {
    outboxFindManyMock.mockResolvedValue([row(1)])
    readyAfterRounds(3, 0)

    await drainSearchOutboxUntilEmpty({ roundMs: 1000, waitMs: 0 })

    expect(withJobLeaseMock).toHaveBeenCalledTimes(2)
  })

  it('写锁在 cron 的 drain 手里时等它, 可取的在减少就算有进展', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    withJobLeaseMock.mockImplementation(async () => {
      now += 30_000
      return { ran: false }
    })
    readyAfterRounds(5, 4, 3, 2, 0)
    const rounds: string[] = []

    await drainSearchOutboxUntilEmpty({
      waitMs: 0,
      stallMs: 60_000,
      onRound: (round) => rounds.push(round.outcome)
    })

    expect(rounds).toHaveLength(5)
    expect(new Set(rounds)).toEqual(new Set(['locked']))
  })

  it('既没写入、可取的也没减少 (锁一直拿不到或引擎收不了写入), 到时限就报错', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    withJobLeaseMock.mockImplementation(async () => {
      now += 60_000
      return { ran: false }
    })
    outboxCountMock.mockResolvedValue(7)

    await expect(
      drainSearchOutboxUntilEmpty({ waitMs: 0, stallMs: 5 * 60_000 })
    ).rejects.toThrow('剩余可取 7 条交给 cron 进程排空')
    expect(withJobLeaseMock.mock.calls.length).toBeLessThanOrEqual(6)
  })

  it('未配置 Meilisearch 时直接返回', async () => {
    getMeiliClientMock.mockReturnValue(null)

    await drainSearchOutboxUntilEmpty()

    expect(outboxCountMock).not.toHaveBeenCalled()
  })
})
