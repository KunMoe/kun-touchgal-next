import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// kunTx 在真实 PostgreSQL 上的行为 (运行方式见 server/db/__tests__/dbContract.ts)。
// 单元测试里的违例与冲突都是手工造的对象; 这里钉住驱动真正抛出来的错误: 判据认不出
// 它们的话, violations 不翻译、retry 不重放, 而单元测试照样全绿

// 库里不存在的 id (user 表在用例开始时是空的)
const MISSING_ID = 2147480000

describe.skipIf(!dbContractUrl)('kunTx on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let kunTx: typeof import('~/server/db/tx').kunTx
  let isPrismaTransactionConflict: typeof import('~/server/db/txErrors').isPrismaTransactionConflict
  let createdUserIds: number[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
    ;({ kunTx } = await import('~/server/db/tx'))
    ;({ isPrismaTransactionConflict } = await import('~/server/db/txErrors'))
  })

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    createdUserIds = []
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  const newUser = async () => {
    const user = await prisma.user.create({
      data: {
        name: randomUUID().slice(0, 17),
        email: `${randomUUID()}@example.com`,
        password: 'hash'
      }
    })
    createdUserIds.push(user.id)
    return user
  }

  const bioOf = async (id: number) =>
    (await prisma.user.findUnique({ where: { id }, select: { bio: true } }))
      ?.bio

  describe('提交边界', () => {
    it('fail 回滚先行的写入, 执行清理, 不执行提交后副作用', async () => {
      const user = await newUser()
      const calls: string[] = []

      const result = await kunTx('contract', async (ctx) => {
        await ctx.tx.user.update({
          where: { id: user.id },
          data: { bio: 'written' }
        })
        ctx.afterCommit('cache', () => calls.push('afterCommit'))
        ctx.onRollback('cleanup', () => calls.push('onRollback'))
        ctx.fail('不行')
      })

      expect(result).toBe('不行')
      expect(await bioOf(user.id)).toBe('')
      expect(calls).toEqual(['onRollback'])
    })

    it('commitWith 提交先行的写入, 以消息作为结果', async () => {
      const user = await newUser()
      const calls: string[] = []

      const result = await kunTx('contract', async (ctx) => {
        await ctx.tx.user.update({
          where: { id: user.id },
          data: { bio: 'written' }
        })
        // 提交之后才执行: 换一个连接已经读得到这次写入
        ctx.afterCommit('cache', async () => {
          calls.push(`afterCommit:${await bioOf(user.id)}`)
        })
        ctx.onRollback('cleanup', () => calls.push('onRollback'))
        return ctx.commitWith('失败但提交')
      })

      expect(result).toBe('失败但提交')
      expect(await bioOf(user.id)).toBe('written')
      expect(calls).toEqual(['afterCommit:written'])
    })
  })

  describe('违例文案', () => {
    it('唯一约束 (P2002) 翻成文案, 同一事务里先行的写入回滚', async () => {
      const [first, second] = [await newUser(), await newUser()]

      const result = await kunTx(
        'contract',
        async ({ tx }) => {
          await tx.user.update({
            where: { id: second.id },
            data: { bio: 'written' }
          })
          await tx.user.update({
            where: { id: second.id },
            data: { email: first.email }
          })
        },
        { violations: { P2002: '邮箱已被使用' } }
      )

      expect(result).toBe('邮箱已被使用')
      expect(await bioOf(second.id)).toBe('')
    })

    it('外键 (P2003) 翻成文案', async () => {
      const user = await newUser()

      const result = await kunTx(
        'contract',
        async ({ tx }) => {
          await tx.user_follow_relation.create({
            data: { follower_id: user.id, following_id: MISSING_ID }
          })
        },
        { violations: { P2003: '未找到用户' } }
      )

      expect(result).toBe('未找到用户')
    })

    it('目标行不存在 (P2025) 翻成文案', async () => {
      const result = await kunTx(
        'contract',
        async ({ tx }) => {
          await tx.user.update({
            where: { id: MISSING_ID },
            data: { bio: 'x' }
          })
        },
        { violations: { P2025: '未找到用户' } }
      )

      expect(result).toBe('未找到用户')
    })

    it('表里没有的违例原样抛出, 带着 Prisma 的 code', async () => {
      await expect(
        kunTx(
          'contract',
          async ({ tx }) => {
            await tx.user.update({
              where: { id: MISSING_ID },
              data: { bio: 'x' }
            })
          },
          { violations: { P2002: '邮箱已被使用' } }
        )
      ).rejects.toMatchObject({ code: 'P2025' })
    })
  })

  describe('事务冲突', () => {
    const lockUser = (tx: { $queryRaw: typeof prisma.$queryRaw }, id: number) =>
      tx.$queryRaw`SELECT id FROM "user" WHERE id = ${id} FOR UPDATE`

    // 两个事务按相反的顺序锁同两行, 库在 deadlock_timeout (1 秒) 后回滚其中一个
    it('retry 额度内重放被死锁回滚的一方, 两边最终都提交', async () => {
      const [a, b] = [await newUser(), await newUser()]
      const barrier = () => {
        let open!: () => void
        const opened = new Promise<void>((resolve) => {
          open = resolve
        })
        return { open, opened }
      }
      const firstLocked = [barrier(), barrier()]
      let attempts = 0

      const run = (self: 0 | 1, firstId: number, secondId: number) =>
        kunTx(
          'contract',
          async ({ tx }) => {
            attempts++
            await lockUser(tx, firstId)
            firstLocked[self].open()
            // 首轮等对方也拿到第一把锁, 保证互等成环; 重放时闸门早已打开
            await firstLocked[1 - self].opened
            await lockUser(tx, secondId)
            await tx.user.update({
              where: { id: firstId },
              data: { moemoepoint: { increment: 1 } }
            })
            return { self }
          },
          { retry: 2, timeout: 20000 }
        )

      const results = await Promise.all([
        run(0, a.id, b.id),
        run(1, b.id, a.id)
      ])

      expect(results).toEqual([{ self: 0 }, { self: 1 }])
      // 被回滚的一方重放了一次
      expect(attempts).toBe(3)
      const rows = await prisma.user.findMany({
        where: { id: { in: [a.id, b.id] } },
        orderBy: { id: 'asc' },
        select: { moemoepoint: true }
      })
      expect(rows.map((row) => row.moemoepoint)).toEqual([
        a.moemoepoint + 1,
        b.moemoepoint + 1
      ])
    })

    // 不在事务里的单条语句同样会被死锁检测选中 (站内信批量已读是这种形状)。这里让检查只由
    // 它发起, 被回滚的就是它
    it('不在事务里的单条原生语句被死锁回滚时, 抛出的错误认得出是冲突', async () => {
      const [a, b] = [await newUser(), await newUser()]
      const marker = `kun-tx-contract-${randomUUID()}`
      let bare: Promise<unknown> | undefined

      const isBareWaiting = async () => {
        const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`
          SELECT count(*) AS waiting FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE ${`%${marker}%`}
            AND pid <> pg_backend_pid()`
        return row.waiting > 0n
      }

      const holder = prisma.$transaction(
        async (tx) => {
          // 死锁检查由等待者各自在等满 deadlock_timeout 时做一次, 查到环的那个把自己回滚。
          // 两边开始等锁只差一两毫秒, 留给定时器的抖动去决定谁先查的话, 这个事务有时会
          // 成为被回滚的一方。把它自己的时限调到用例跑不到的长度, 检查就只会由那条裸语句
          // 发起 (它用库的默认值, 1 秒)。改这个参数要超级用户, 回放库与 CI 都是
          await tx.$executeRawUnsafe(`SET LOCAL deadlock_timeout = '1min'`)
          await lockUser(tx, a.id)
          // 排序在加锁之前: 先锁 b, 再去等被上面占着的 a
          bare = prisma.$queryRawUnsafe(
            `SELECT id FROM "user" WHERE id IN (${a.id}, ${b.id}) ORDER BY id DESC FOR UPDATE /* ${marker} */`
          )
          bare.catch(() => {})
          while (!(await isBareWaiting())) {
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          await lockUser(tx, b.id)
        },
        { timeout: 20000 }
      )

      await holder
      const failure = await bare!.then(
        () => undefined,
        (error: unknown) => error
      )

      expect(failure).toBeDefined()
      expect(isPrismaTransactionConflict(failure)).toBe(true)
    })
  })
})
