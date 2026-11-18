import { randomUUID } from 'crypto'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// S3 删除写出箱在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// 引用谓词的 content 尾段、upsert 换发 seq、判定之后的 (s3_key, seq) 删行撞上未提交的重新
// 入队: 这三件事 mock 测不出来

const { deleteFileFromS3Mock } = vi.hoisted(() => ({
  deleteFileFromS3Mock: vi.fn()
}))

vi.mock('~/lib/s3', () => ({ deleteFileFromS3: deleteFileFromS3Mock }))

// 单消费者锁在 Redis 上, 与这里测的库语义无关: 直接执行任务体
vi.mock('~/server/tasks/withTaskLock', () => ({
  withTaskLock: (
    _options: unknown,
    task: (renew: () => Promise<void>) => Promise<unknown>
  ) => task(async () => {})
}))

const STORAGE_URL = 'https://cloud.example.test'

describe.skipIf(!dbContractUrl)('S3 deletion outbox on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let outbox: typeof import('~/server/storage/s3Outbox')
  let references: typeof import('~/server/storage/references')
  let userId: number
  let patchId: number
  let createdKeys: string[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
    outbox = await import('~/server/storage/s3Outbox')
    references = await import('~/server/storage/references')
    const user = await prisma.user.create({
      data: {
        name: randomUUID().slice(0, 17),
        email: `${randomUUID()}@example.com`,
        password: 'x'
      }
    })
    userId = user.id
    const patch = await prisma.patch.create({
      data: {
        unique_id: randomUUID().slice(0, 8),
        name: 's3 outbox contract',
        user_id: userId
      }
    })
    patchId = patch.id
  })

  beforeEach(() => {
    deleteFileFromS3Mock.mockReset().mockResolvedValue(undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await prisma.patch_resource.deleteMany({ where: { patch_id: patchId } })
    await prisma.s3_deletion_outbox.deleteMany({
      where: { s3_key: { in: createdKeys } }
    })
    createdKeys = []
  })

  afterAll(async () => {
    // 资源、链接随 patch 与用户级联删除
    await prisma?.user.deleteMany({ where: { id: userId } })
    await prisma?.$disconnect()
  })

  const newKey = (forPatch = patchId) => {
    const key = `patch/${forPatch}/resource/${randomUUID()}/file.zip`
    createdKeys.push(key)
    return key
  }

  // 历史形态: s3_key 为空, 对象 key 只能从 content 尾段还原 (hash 可能已被写空)
  const newLink = async (
    link: { content: string; s3_key?: string; storage?: string },
    status = 0
  ) => {
    const resource = await prisma.patch_resource.create({
      data: {
        section: 'galgame',
        user_id: userId,
        patch_id: patchId,
        status,
        links: {
          create: {
            storage: link.storage ?? 's3',
            s3_key: link.s3_key ?? '',
            content: link.content
          }
        }
      },
      include: { links: true }
    })
    return resource.links[0]
  }

  const isReferenced = (key: string) =>
    references.isS3ObjectReferenced(prisma, key)

  const outboxRow = (key: string) =>
    prisma.s3_deletion_outbox.findUnique({ where: { s3_key: key } })

  describe('isS3ObjectReferenced', () => {
    it('s3_key 精确相等算引用', async () => {
      const key = newKey()
      await newLink({ content: `${STORAGE_URL}/${key}`, s3_key: key })

      expect(await isReferenced(key)).toBe(true)
    })

    it('历史行按 content 尾段算引用, 不看 hash', async () => {
      const key = newKey()
      await newLink({ content: `${STORAGE_URL}/${key}` })

      expect(await isReferenced(key)).toBe(true)
    })

    it('旧代码写进别的游戏前缀的对象, 按 content 尾段仍认得出持有者', async () => {
      const key = newKey(patchId + 1)
      await newLink({ content: `${STORAGE_URL}/${key}` })

      expect(await isReferenced(key)).toBe(true)
    })

    it('尾段要在 / 边界上整段相等: patch/1 与 patch/11 互不认领', async () => {
      const segment = randomUUID()
      const shortKey = `patch/1/resource/${segment}/file.zip`
      const longKey = `patch/11/resource/${segment}/file.zip`
      await newLink({ content: `${STORAGE_URL}/${longKey}` })

      expect(await isReferenced(shortKey)).toBe(false)
      expect(await isReferenced(`1/resource/${segment}/file.zip`)).toBe(false)
      expect(await isReferenced(longKey)).toBe(true)
    })

    it('content 恰为桶地址的外链行不算引用', async () => {
      const key = newKey()
      await newLink({ content: `${STORAGE_URL}/${key}`, storage: 'user' })

      expect(await isReferenced(key)).toBe(false)
    })

    it('隐藏、待审核的资源同样持有对象', async () => {
      const key = newKey()
      await newLink({ content: `${STORAGE_URL}/${key}` }, 1)

      expect(await isReferenced(key)).toBe(true)
    })

    it('最后一个持有者删掉之后判为无引用', async () => {
      const key = newKey()
      const first = await newLink({ content: `${STORAGE_URL}/${key}` })
      const second = await newLink({ content: `${STORAGE_URL}/${key}` })

      await prisma.patch_resource_link.delete({ where: { id: first.id } })
      expect(await isReferenced(key)).toBe(true)
      await prisma.patch_resource_link.delete({ where: { id: second.id } })
      expect(await isReferenced(key)).toBe(false)
    })
  })

  describe('enqueueS3Deletion', () => {
    it('同一批里的重复 key 合并为一行, 不报 21000', async () => {
      const key = newKey()

      await outbox.enqueueS3Deletion(prisma, [key, key])

      expect(
        await prisma.s3_deletion_outbox.count({ where: { s3_key: key } })
      ).toBe(1)
      expect(await outboxRow(key)).toMatchObject({ attempts: 0 })
    })

    it('重复入队换发 seq, 保留 attempts 与 created, 刷新 updated 排到队尾', async () => {
      const key = newKey()
      await outbox.enqueueS3Deletion(prisma, [key])
      const old = new Date('2026-01-01T00:00:00Z')
      await prisma.s3_deletion_outbox.update({
        where: { s3_key: key },
        data: { attempts: 2, updated: old }
      })
      const before = await outboxRow(key)

      await outbox.enqueueS3Deletion(prisma, [key])

      const after = await outboxRow(key)
      expect(after!.seq).not.toBe(before!.seq)
      expect(after?.attempts).toBe(2)
      expect(after?.created).toEqual(before?.created)
      expect(after!.updated.getTime()).toBeGreaterThan(old.getTime())
    })

    it('删掉之后重新插入的行拿到新的 seq: 按旧读数删行不会带走它', async () => {
      const key = newKey()
      await outbox.enqueueS3Deletion(prisma, [key])
      const first = await outboxRow(key)
      await prisma.s3_deletion_outbox.deleteMany({
        where: { s3_key: key, seq: first!.seq }
      })

      // 续锁失败时另一个 drain 还拿着 (key, 旧 seq) 的读数
      await outbox.enqueueS3Deletion(prisma, [key])
      const stale = await prisma.s3_deletion_outbox.deleteMany({
        where: { s3_key: key, seq: first!.seq }
      })

      expect(stale.count).toBe(0)
      expect(await outboxRow(key)).not.toBeNull()
    })
  })

  describe('drainS3DeletionOutbox', () => {
    it('共享对象删掉一条链接: 对象不删, 出箱行移除; 删掉最后一条才删对象', async () => {
      const key = newKey()
      const first = await newLink({ content: `${STORAGE_URL}/${key}` })
      const second = await newLink({ content: `${STORAGE_URL}/${key}` })

      await prisma.$transaction(async (tx) => {
        await tx.patch_resource_link.delete({ where: { id: first.id } })
        await outbox.enqueueS3Deletion(tx, [key])
      })
      expect(await outbox.drainS3DeletionOutbox()).toEqual({
        deleted: 0,
        skippedReferenced: 1
      })
      expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
      expect(await outboxRow(key)).toBeNull()

      await prisma.$transaction(async (tx) => {
        await tx.patch_resource_link.delete({ where: { id: second.id } })
        await outbox.enqueueS3Deletion(tx, [key])
      })
      expect(await outbox.drainS3DeletionOutbox()).toEqual({
        deleted: 1,
        skippedReferenced: 0
      })
      expect(deleteFileFromS3Mock).toHaveBeenCalledWith(key)
      expect(await outboxRow(key)).toBeNull()
    })

    it('判定之后、删行之前有事务删掉最后持有者并重新入队: 行留到下一轮, 下一轮删对象', async () => {
      const key = newKey()
      const lastHolder = await newLink({ content: `${STORAGE_URL}/${key}` })
      // 另一条共享链接先前已被删除, 它的入队还在出箱里
      await outbox.enqueueS3Deletion(prisma, [key])
      const queued = await outboxRow(key)

      let txReady!: () => void
      const txStarted = new Promise<void>((resolve) => (txReady = resolve))
      let commit!: () => void
      const committed = new Promise<void>((resolve) => (commit = resolve))
      const removal = prisma.$transaction(
        async (tx) => {
          await tx.patch_resource_link.delete({ where: { id: lastHolder.id } })
          await outbox.enqueueS3Deletion(tx, [key])
          txReady()
          await committed
        },
        { timeout: 20_000 }
      )
      await txStarted

      // 未提交的删除对 drain 不可见: 判为仍被引用, 删行撞上那个事务在出箱行上的行锁
      const drain = outbox.drainS3DeletionOutbox()
      await vi.waitFor(
        async () => {
          const [{ waiting }] = await prisma.$queryRaw<{ waiting: bigint }[]>`
            SELECT count(*) AS waiting FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query ILIKE 'DELETE%s3_deletion_outbox%'`
          expect(waiting).toBe(1n)
        },
        { timeout: 10_000, interval: 50 }
      )
      commit()
      await removal

      expect(await drain).toEqual({ deleted: 0, skippedReferenced: 1 })
      expect(deleteFileFromS3Mock).not.toHaveBeenCalled()
      const kept = await outboxRow(key)
      expect(kept).not.toBeNull()
      expect(kept!.seq).not.toBe(queued!.seq)

      expect(await outbox.drainS3DeletionOutbox()).toEqual({
        deleted: 1,
        skippedReferenced: 0
      })
      expect(deleteFileFromS3Mock).toHaveBeenCalledWith(key)
      expect(await outboxRow(key)).toBeNull()
    })
  })
})
