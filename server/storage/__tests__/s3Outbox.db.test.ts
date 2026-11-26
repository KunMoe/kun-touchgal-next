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
// 引用谓词的整段相等、upsert 换发 seq、判定之后的 (s3_key, seq) 删行撞上未提交的重新入队:
// 这三件事 mock 测不出来

const { deleteFileFromS3Mock } = vi.hoisted(() => ({
  deleteFileFromS3Mock: vi.fn()
}))

vi.mock('~/lib/s3', () => ({ deleteFileFromS3: deleteFileFromS3Mock }))
vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

// 单消费者锁在 Redis 上, 与这里测的库语义无关: 直接执行任务体
vi.mock('~/server/jobs/lease', () => ({
  withJobLease: async (
    _spec: unknown,
    fn: (lease: {
      signal: AbortSignal
      progress: () => void
    }) => Promise<unknown>
  ) => ({
    ran: true,
    value: await fn({
      signal: new AbortController().signal,
      progress: () => {}
    })
  })
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

  // 回填之后的形态: storage = 's3' 的行都带 s3_key, content 是「存储地址/对象 key」
  const newLink = async (
    link: { content: string; s3_key?: string; storage?: string },
    status = 0
  ) => {
    const storage = link.storage ?? 's3'
    const resource = await prisma.patch_resource.create({
      data: {
        section: 'galgame',
        user_id: userId,
        patch_id: patchId,
        status,
        links: {
          create: {
            storage,
            s3_key:
              link.s3_key ??
              (storage === 's3'
                ? link.content.slice(STORAGE_URL.length + 1)
                : ''),
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
      await newLink({ content: `${STORAGE_URL}/${key}` })

      expect(await isReferenced(key)).toBe(true)
    })

    it('只认整段相等: 别的 key 的前缀、后缀不算', async () => {
      const segment = randomUUID()
      const longKey = `patch/11/resource/${segment}/file.zip`
      await newLink({ content: `${STORAGE_URL}/${longKey}` })

      expect(await isReferenced(`patch/1/resource/${segment}/file.zip`)).toBe(
        false
      )
      expect(await isReferenced(`1/resource/${segment}/file.zip`)).toBe(false)
      expect(await isReferenced(`patch/11/resource/${segment}`)).toBe(false)
      expect(await isReferenced(longKey)).toBe(true)
    })

    it('s3_key 为空的行不算引用: 收窄之后历史形态必须已经回填完', async () => {
      const key = newKey()
      await newLink({ content: `${STORAGE_URL}/${key}`, s3_key: '' })

      expect(await isReferenced(key)).toBe(false)
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

    it('共享对象的最后一个持有者删掉之后判为无引用', async () => {
      const key = newKey()
      const first = await newLink({ content: `${STORAGE_URL}/${key}` })
      const second = await newLink({ content: `${STORAGE_URL}/${key}` })

      await prisma.patch_resource_link.delete({ where: { id: first.id } })
      expect(await isReferenced(key)).toBe(true)
      await prisma.patch_resource_link.delete({ where: { id: second.id } })
      expect(await isReferenced(key)).toBe(false)
    })
  })

  // 封面没有链接行, 持有者是 patch.banner 指针
  describe('封面版本的引用判定', () => {
    const version = () => `patch/${patchId}/banner/${randomUUID()}`
    const objectsIn = (dir: string) => {
      const keys = [
        `${dir}/banner.avif`,
        `${dir}/banner-mini.avif`,
        `${dir}/banner-full.avif`
      ]
      createdKeys.push(...keys)
      return keys
    }
    const pointTo = (banner: string) =>
      prisma.patch.update({ where: { id: patchId }, data: { banner } })

    afterEach(() => pointTo(''))

    it('指针所在版本目录的对象算在用, 别的版本与固定目录不算', async () => {
      const current = version()
      const replaced = version()
      await pointTo(`${STORAGE_URL}/${current}/banner.avif`)

      for (const key of objectsIn(current)) {
        expect(await isReferenced(key)).toBe(true)
      }
      for (const key of objectsIn(replaced)) {
        expect(await isReferenced(key)).toBe(false)
      }
      for (const key of objectsIn(`patch/${patchId}/banner`)) {
        expect(await isReferenced(key)).toBe(false)
      }
    })

    it('存量的固定目录指针持有固定目录, 换过域名也算', async () => {
      await pointTo(
        `https://old-domain.example.test/patch/${patchId}/banner/banner.avif`
      )

      for (const key of objectsIn(`patch/${patchId}/banner`)) {
        expect(await isReferenced(key)).toBe(true)
      }
    })

    it('游戏不存在时不算在用', async () => {
      const [key] = objectsIn(`patch/2147483000/banner/${randomUUID()}`)

      expect(await isReferenced(key)).toBe(false)
    })

    it('drain 不删在用的版本, 只删换下来的版本', async () => {
      const current = version()
      const replaced = version()
      await pointTo(`${STORAGE_URL}/${current}/banner.avif`)
      const currentKeys = objectsIn(current)
      const replacedKeys = objectsIn(replaced)

      await outbox.enqueueS3Deletion(prisma, [...currentKeys, ...replacedKeys])

      expect(await outbox.drainS3DeletionOutbox()).toEqual({
        deleted: 3,
        skippedReferenced: 3
      })
      expect(
        deleteFileFromS3Mock.mock.calls.map(([key]) => key).sort()
      ).toEqual([...replacedKeys].sort())
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

  // 宽限期的时刻在库里按 UTC 墙钟算, drain 用 Prisma 的 Date 比: 两边的时基必须相同, 差 8 小时的话
  // 旧封面要么永远不删, 要么提前删
  describe('not_before 宽限期', () => {
    const HOUR = 60 * 60 * 1000

    const notBeforeOf = async (key: string) =>
      (await outboxRow(key))?.not_before ?? null

    it('入队写下的时刻与 Prisma 读回的 Date 同一时基; 不传 delayMs 是 NULL', async () => {
      const delayed = newKey()
      const immediate = newKey()

      // 会话时区不是 UTC 时 (本机的开发库是 Asia/Hong_Kong) 裸 now() 写进无时区列会差出 8 小时;
      // 回放库默认 UTC, 测不出来, 所以在事务里把会话时区改掉
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Hong_Kong'`
        await outbox.enqueueS3Deletion(tx, [delayed], { delayMs: HOUR })
      })
      await outbox.enqueueS3Deletion(prisma, [immediate])

      const notBefore = await notBeforeOf(delayed)
      expect(Math.abs(notBefore!.getTime() - (Date.now() + HOUR))).toBeLessThan(
        60_000
      )
      expect(await notBeforeOf(immediate)).toBeNull()
    })

    it('drain 跳过还没到时刻的行, 处理 NULL 与已到时刻的行', async () => {
      const waiting = newKey()
      const immediate = newKey()
      const due = newKey()
      await outbox.enqueueS3Deletion(prisma, [waiting, due], {
        delayMs: 24 * HOUR
      })
      await outbox.enqueueS3Deletion(prisma, [immediate])
      await prisma.s3_deletion_outbox.update({
        where: { s3_key: due },
        data: { not_before: new Date(Date.now() - 1000) }
      })

      expect(await outbox.drainS3DeletionOutbox()).toEqual({
        deleted: 2,
        skippedReferenced: 0
      })
      expect(
        deleteFileFromS3Mock.mock.calls.map(([key]) => key).sort()
      ).toEqual([immediate, due].sort())
      expect(await outboxRow(waiting)).not.toBeNull()
      expect(await outboxRow(immediate)).toBeNull()
      expect(await outboxRow(due)).toBeNull()
    })

    it('重复入队取更早的时刻, 立即优先', async () => {
      const shorterLater = newKey()
      const longerLater = newKey()
      const immediateLater = newKey()
      const delayedLater = newKey()

      await outbox.enqueueS3Deletion(prisma, [shorterLater], {
        delayMs: 24 * HOUR
      })
      await outbox.enqueueS3Deletion(prisma, [shorterLater], { delayMs: HOUR })
      await outbox.enqueueS3Deletion(prisma, [longerLater], { delayMs: HOUR })
      await outbox.enqueueS3Deletion(prisma, [longerLater], {
        delayMs: 24 * HOUR
      })
      await outbox.enqueueS3Deletion(prisma, [immediateLater], {
        delayMs: HOUR
      })
      await outbox.enqueueS3Deletion(prisma, [immediateLater])
      await outbox.enqueueS3Deletion(prisma, [delayedLater])
      await outbox.enqueueS3Deletion(prisma, [delayedLater], { delayMs: HOUR })

      const inOneHour = Date.now() + HOUR
      for (const key of [shorterLater, longerLater]) {
        const notBefore = await notBeforeOf(key)
        expect(Math.abs(notBefore!.getTime() - inOneHour)).toBeLessThan(60_000)
      }
      expect(await notBeforeOf(immediateLater)).toBeNull()
      expect(await notBeforeOf(delayedLater)).toBeNull()
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
