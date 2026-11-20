import { randomUUID } from 'crypto'
import pg from 'pg'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { kunTestActor } from '~/app/api/utils/__tests__/kunTestActor'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// 发起私聊的扣费在真实 PostgreSQL 上的落败分支 (运行方式见 server/db/__tests__/dbContract.ts)。
// 扣费那条条件更新的形状由编译契约钉住 (service.sql.test.ts), 「平铺的 WHERE 会被库重新
// 求值」 由签到的金丝雀钉住; 这里看的是两者合起来之后的业务结果: 并发的落败者拿到什么、
// 钱扣了几次、会话建了几个。需要 20 萌萌点才能发起, 每次扣 10

const INSUFFICIENT = '萌萌点不足，发起私聊需要至少 20 萌萌点'

// 会话缓存在 Redis 里, 与这里要看的事无关
vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

describe.skipIf(!dbContractUrl)('conversation fee on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let getOrCreateConversation: typeof import('~/app/api/message/conversation/service').getOrCreateConversation
  let createdUserIds: number[] = []
  const clients: pg.Client[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
    ;({ getOrCreateConversation } =
      await import('~/app/api/message/conversation/service'))
  })

  afterEach(async () => {
    // 先收连接: 失败的用例可能还握着行锁, 不收的话下面的删除会一直等
    await Promise.all(clients.splice(0).map((client) => client.end()))
    // 会话随 user 级联
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    createdUserIds = []
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  const connect = async () => {
    const client = new pg.Client({ connectionString: dbContractUrl })
    await client.connect()
    clients.push(client)
    return client
  }

  const newUser = async (moemoepoint = 0) => {
    const user = await prisma.user.create({
      data: {
        name: randomUUID().slice(0, 17),
        email: `${randomUUID()}@example.com`,
        password: 'hash',
        moemoepoint
      }
    })
    createdUserIds.push(user.id)
    return user
  }

  const balanceOf = async (id: number) =>
    (
      await prisma.user.findUniqueOrThrow({
        where: { id },
        select: { moemoepoint: true }
      })
    ).moemoepoint

  const conversationsOf = (id: number) =>
    prisma.user_conversation.findMany({
      where: { OR: [{ user_a_id: id }, { user_b_id: id }] },
      select: { id: true, user_a_id: true, user_b_id: true }
    })

  // 等到恰有 expected 个会话排在锁上。观察用的连接不开事务: pg_stat_activity 在同一个事务
  // 里读到的是第一次读取时的快照
  const waitForLockWaiters = async (observer: pg.Client, expected: number) => {
    const sessions = () =>
      observer.query<{
        pid: number
        wait_event_type: string | null
        query: string
      }>(
        `SELECT pid, wait_event_type, left(query, 60) AS query
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()`
      )
    for (let i = 0; ; i++) {
      const { rows } = await sessions()
      const waiting = rows.filter((row) => row.wait_event_type === 'Lock')
      if (waiting.length === expected) {
        return
      }
      // 上限要低于用例的超时 (默认 5 秒), 否则先到的是超时, 这条带现场的错误出不来
      if (i > 150) {
        throw new Error(
          `等了 3 秒只有 ${waiting.length}/${expected} 个会话排在锁上: ${JSON.stringify(rows)}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  // 锁闸门: 另一条连接先占住发起人这一行, 等两个请求的扣费语句都排在行锁后面再放行。
  // 两个请求在事务之外的那几次读取 (余额、有没有现成的会话) 不受行锁影响, 此时都已读完:
  // 余额都是扣费之前的, 会话都还没有。谁胜出、落败者走哪条分支, 只取决于库拿到锁之后的事
  const raceBehindRowLock = async <T>(
    uid: number,
    fire: () => Promise<T>[]
  ) => {
    const [holder, observer] = [await connect(), await connect()]
    await holder.query('BEGIN')
    await holder.query('SELECT 1 FROM "user" WHERE id = $1 FOR UPDATE', [uid])

    const pending = fire()
    const settled = Promise.allSettled(pending)
    try {
      await waitForLockWaiters(observer, pending.length)
    } finally {
      await holder.query('COMMIT')
      await settled
    }
    return Promise.all(pending)
  }

  const open = (uid: number, targetUserId: number) =>
    getOrCreateConversation({ targetUserId }, kunTestActor({ uid, role: 1 }))

  // 余额 25: 赢家扣到 15, 落败者的条件更新被库重新求值后落空 (15 < 20), 走不到建会话。
  // 余额 40: 赢家扣到 30, 落败者的条件更新仍然成立 (扣到 20), 接着建会话撞唯一索引,
  // 整个事务回滚, 那 10 点退回。两条分支的落败者都该拿到赢家建好的会话
  it.each([
    { balance: 25, branch: '条件更新落空后回读', left: 15 },
    { balance: 40, branch: '撞唯一索引后回滚并回读', left: 30 }
  ])(
    '余额 $balance, 同一目标的两个并发请求: 落败者 ($branch) 拿到赢家建好的会话, 只扣一次',
    async ({ balance, left }) => {
      const [sender, target] = [await newUser(balance), await newUser()]

      const results = await raceBehindRowLock(sender.id, () => [
        open(sender.id, target.id),
        open(sender.id, target.id)
      ])

      const conversations = await conversationsOf(sender.id)
      expect(conversations).toEqual([
        { id: expect.any(Number), user_a_id: sender.id, user_b_id: target.id }
      ])
      const conversationId = conversations[0].id
      expect(results).toHaveLength(2)
      expect(results).toContainEqual({ conversationId, isNew: true })
      expect(results).toContainEqual({ conversationId, isNew: false })
      await expect(balanceOf(sender.id)).resolves.toBe(left)
    }
  )

  // 唯一索引只管同一对用户。发往不同目标的并发请求之间, 挡住第二次扣费的只有条件更新
  it('余额只够开一次, 两个并发请求发往不同目标: 一个开成, 另一个报萌萌点不足, 余额只扣一次', async () => {
    const sender = await newUser(25)
    const targets = [await newUser(), await newUser()]

    const results = await raceBehindRowLock(sender.id, () =>
      targets.map((target) => open(sender.id, target.id))
    )

    const conversations = await conversationsOf(sender.id)
    expect(conversations).toHaveLength(1)
    expect(results).toHaveLength(2)
    expect(results).toContainEqual({
      conversationId: conversations[0].id,
      isNew: true
    })
    expect(results).toContainEqual(INSUFFICIENT)
    await expect(balanceOf(sender.id)).resolves.toBe(15)
  })
})
