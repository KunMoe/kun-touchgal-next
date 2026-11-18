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

// 搜索写出箱入队在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// seq 是消费者按 (patch_id, seq) 删行的认领令牌, 要求永不重复: 这件事 mock 测不出来

vi.mock('~/lib/meilisearch', () => ({ getMeiliClient: () => null }))

describe.skipIf(!dbContractUrl)('search outbox on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let sync: typeof import('~/server/search/sync')
  let patchIds: number[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
    sync = await import('~/server/search/sync')
  })

  afterEach(async () => {
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
})
