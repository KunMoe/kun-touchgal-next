import { randomInt } from 'crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// 搜索写出箱在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// seq 是消费者按 (patch_id, seq) 删行的认领令牌, 要求永不重复; 失败记录由入队复位与否、
// 退避到期的判定 (无时区列里的 UTC 墙钟) 都要在真库上看: 这些 mock 测不出来

const { meili } = vi.hoisted(() => ({
  meili: { enabled: false, deleteTask: { status: 'succeeded' } as object }
}))

// drain 用例里 Meilisearch 只答「删掉了」(夹具的 patch 都不存在, drain 走删除分支)
vi.mock('~/lib/meilisearch', () => ({
  getMeiliClient: () =>
    meili.enabled
      ? {
          index: () => ({
            deleteDocument: () => ({ waitTask: async () => meili.deleteTask })
          })
        }
      : null
}))

// 单测连不上 Redis (vitest.config.ts 的 test.env), 写锁直接放行
vi.mock('~/server/jobs/lease', () => ({
  withJobLease: async (
    _spec: unknown,
    fn: (lease: { signal: AbortSignal }) => Promise<unknown>
  ) => ({
    ran: true,
    value: await fn({ signal: new AbortController().signal })
  })
}))

describe.skipIf(!dbContractUrl)('search outbox on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let sync: typeof import('~/server/search/sync')
  let patchIds: number[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
    sync = await import('~/server/search/sync')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    meili.enabled = false
    meili.deleteTask = { status: 'succeeded' }
    await prisma.search_outbox.deleteMany({
      where: { patch_id: { in: patchIds } }
    })
    patchIds = []
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  // patch_id 不设外键, 取 int4 上段的随机值, 不与别的用例相撞
  const newPatchId = () => {
    const id = randomInt(2_000_000_000, 2_147_483_647)
    patchIds.push(id)
    return id
  }

  const row = (patchId: number) =>
    prisma.search_outbox.findUnique({ where: { patch_id: patchId } })

  it('单条与批量的重复入队都换发 seq, 批内重复 id 合并为一行', async () => {
    const id = newPatchId()
    await sync.enqueueSearchOutboxBatch(prisma, [id, id])
    const first = await row(id)

    await sync.enqueueSearchOutbox(prisma, id)
    const second = await row(id)
    await sync.enqueueSearchOutboxBatch(prisma, [id])
    const third = await row(id)

    expect(new Set([first!.seq, second!.seq, third!.seq]).size).toBe(3)
  })

  it('删掉之后重新插入的行拿到新的 seq: 按旧读数删行不会带走它', async () => {
    const id = newPatchId()
    await sync.enqueueSearchOutbox(prisma, id)
    const first = await row(id)
    await prisma.search_outbox.deleteMany({
      where: { patch_id: id, seq: first!.seq }
    })

    // 续锁失败时另一个 drain 还拿着 (patch_id, 旧 seq) 的读数
    await sync.enqueueSearchOutbox(prisma, id)
    const stale = await prisma.search_outbox.deleteMany({
      where: { patch_id: id, seq: first!.seq }
    })

    expect(stale.count).toBe(0)
    expect(await row(id)).not.toBeNull()
  })

  const failed = {
    attempts: 4,
    next_attempt_at: new Date(Date.now() + 60 * 60 * 1000),
    last_error: 'x'
  }

  it('应用写入的入队复位失败记录, 对账的入队只换发 seq', async () => {
    const written = newPatchId()
    const reconciled = newPatchId()
    await sync.enqueueSearchOutboxBatch(prisma, [written, reconciled])
    await prisma.search_outbox.updateMany({
      where: { patch_id: { in: [written, reconciled] } },
      data: failed
    })
    const before = await row(reconciled)

    await sync.enqueueSearchOutbox(prisma, written)
    await sync.enqueueSearchOutboxBatch(prisma, [reconciled], {
      mode: 'reconcile'
    })

    expect(await row(written)).toMatchObject({
      attempts: 0,
      next_attempt_at: null,
      last_error: null
    })
    const after = await row(reconciled)
    expect(after).toMatchObject(failed)
    expect(after!.seq).not.toBe(before!.seq)
  })

  it('drain 只取退避已到期、没隔离的行; 被拒时记下次数与 UTC 墙钟的到期时刻', async () => {
    meili.enabled = true
    const due = newPatchId()
    const waiting = newPatchId()
    const quarantined = newPatchId()
    const rejected = newPatchId()
    await sync.enqueueSearchOutboxBatch(prisma, [
      due,
      waiting,
      quarantined,
      rejected
    ])
    await prisma.search_outbox.updateMany({
      where: { patch_id: due },
      data: { attempts: 3, next_attempt_at: new Date(Date.now() - 1000) }
    })
    await prisma.search_outbox.updateMany({
      where: { patch_id: waiting },
      data: { attempts: 3, next_attempt_at: new Date(Date.now() + 60_000) }
    })
    await prisma.search_outbox.updateMany({
      where: { patch_id: quarantined },
      data: { attempts: sync.SEARCH_OUTBOX_MAX_ATTEMPTS }
    })

    await sync.drainSearchOutbox()

    expect(await row(due)).toBeNull()
    expect(await row(waiting)).toMatchObject({ attempts: 3 })
    expect(await row(quarantined)).toMatchObject({
      attempts: sync.SEARCH_OUTBOX_MAX_ATTEMPTS
    })
    expect(await row(rejected)).toBeNull()

    // 被拒的一行: 第 1 次失败之后等 1 分钟。读回的到期时刻与写入时的 JS 时钟同一基准
    // (无时区列存 UTC 墙钟), 所以紧接着的下一轮不会取它
    vi.spyOn(console, 'error').mockImplementation(() => {})
    meili.deleteTask = {
      status: 'failed',
      error: { code: 'invalid_document_id', type: 'invalid_request' }
    }
    await sync.enqueueSearchOutbox(prisma, rejected)
    const start = Date.now()
    await sync.drainSearchOutbox()
    const failedRow = await row(rejected)
    expect(failedRow).toMatchObject({ attempts: 1 })
    expect(failedRow!.last_error).toContain('invalid_document_id')
    const dueAt = failedRow!.next_attempt_at!.getTime()
    expect(dueAt).toBeGreaterThanOrEqual(start + 60_000 - 1000)
    expect(dueAt).toBeLessThanOrEqual(Date.now() + 60_000 + 1000)

    const next = await sync.drainSearchOutbox()
    expect(next.failed).toBe(0)
    expect(await row(rejected)).toMatchObject({ attempts: 1 })
  })
})
