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
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'

// 条件更新当 CAS 用的前提, 在真实 PostgreSQL 上的样子 (运行方式见
// server/db/__tests__/dbContract.ts)。签到路由的注释与 prisma/__tests__/support/sqlShape.ts
// 的 expectFlatConditionalUpdate 都建立在这条前提上: READ COMMITTED 下, 排在行锁后面的
// UPDATE 拿到锁之后, 库只对目标行重新求值它自己的 WHERE; 写在子查询里的条件不会被重新求值。
// 编译契约 (不连库) 只能证明 Prisma 发出的是平铺的那种形状, 「平铺就安全、子查询就不安全」
// 得在这里看

const { verifyHeaderCookieMock, REWARD } = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn(),
  REWARD: 5
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' }
      })
  }
}))

vi.mock('~/middleware/_verifyHeaderCookie', () => ({
  verifyHeaderCookie: verifyHeaderCookieMock
}))

vi.mock('~/utils/random', () => ({
  randomNormalInt: () => REWARD
}))

// 会话缓存在 Redis 里, 与这里要看的事无关
vi.mock('~/app/api/user/session/cache', () => ({
  invalidateUserSession: vi.fn()
}))

// 同时发出的请求数。每条都要占一条池里的连接等锁, 连接池上限是 10
const CONCURRENCY = 8

describe.skipIf(!dbContractUrl)('daily check-in on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let POST: typeof import('~/app/api/user/status/check-in/route').POST
  let createdUserIds: number[] = []
  const clients: pg.Client[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
    ;({ POST } = await import('~/app/api/user/status/check-in/route'))
  })

  afterEach(async () => {
    // 先收连接: 失败的用例可能还握着行锁, 不收的话下面的删除会一直等
    await Promise.all(clients.splice(0).map((client) => client.end()))
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

  const stateOf = (id: number) =>
    prisma.user.findUniqueOrThrow({
      where: { id },
      select: { moemoepoint: true, daily_check_in: true }
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

  // 锁闸门: 另一条连接先占住这一行, 等 fire 发出的语句全都排在行锁后面再放行。
  // 于是每条语句的快照都早于第一个胜出者的提交, 谁胜出只取决于库拿到锁之后怎么重新求值
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

  it('同一用户的并发签到都排在行锁后面: 恰好一个领到奖励, 萌萌点只加一次', async () => {
    const user = await newUser()
    verifyHeaderCookieMock.mockResolvedValue({ uid: user.id })
    const request = new Request('http://localhost') as unknown as Parameters<
      typeof POST
    >[0]

    const bodies = await raceBehindRowLock(user.id, () =>
      Array.from({ length: CONCURRENCY }, async () => {
        const response = await POST(request)
        return response.json() as Promise<unknown>
      })
    )

    expect(bodies.filter((body) => typeof body !== 'string')).toEqual([
      { randomMoemoepoints: REWARD }
    ])
    expect(bodies.filter((body) => body === '您今天已经签到过了')).toHaveLength(
      CONCURRENCY - 1
    )
    await expect(stateOf(user.id)).resolves.toEqual({
      moemoepoint: user.moemoepoint + REWARD,
      daily_check_in: 1
    })
  })

  // 负对照: 同一个守卫写进子查询。后到者拿到锁之后, 子查询仍按语句开始时的快照求值
  // (那时还没签到), 于是一起通过。Prisma 若把条件更新编译成这种形状, 签到、改名扣费、
  // 图片额度、私信扣费这些靠 count 判定的地方会全部失守。
  // 这条的结果取决于规划器把子查询留作另一个扫描节点 (17 上是 Nested Loop Semi Join,
  // 守卫落在第二个 Index Scan 上)。升 PostgreSQL 主版本后它若变红, 先看执行计划: 规划器
  // 把自连接消掉、守卫回到了目标行的扫描节点上的话, 变的是规划器, 不是上面那条前提
  it('守卫写在子查询里的手写 UPDATE 在同样的并发下重复发奖', async () => {
    const user = await newUser()

    const affected = await raceBehindRowLock(user.id, () =>
      Array.from(
        { length: CONCURRENCY },
        () => prisma.$executeRaw`
          UPDATE "user"
          SET moemoepoint = moemoepoint + ${REWARD}, daily_check_in = 1
          WHERE id IN (
            SELECT id FROM "user" WHERE id = ${user.id} AND daily_check_in = 0
          )`
      )
    )

    const winners = affected.filter((count) => count === 1).length
    expect(winners).toBeGreaterThan(1)
    await expect(stateOf(user.id)).resolves.toEqual({
      moemoepoint: user.moemoepoint + REWARD * winners,
      daily_check_in: 1
    })
  })
})
