import { randomUUID } from 'crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { pgErrors } from '~/prisma/__tests__/support/pgErrorFixtures'
import { dbContractUrl, openDbContract } from '~/server/db/__tests__/dbContract'
import type { PgErrorFields } from '~/prisma/__tests__/support/sqlRecorder'

// 错误夹具的保鲜 (运行方式见 server/db/__tests__/dbContract.ts)。
// prisma/__tests__/support/pgErrorFixtures.ts 里的字段集由不连库的录制客户端回放,
// error-contract.test.ts 据此断言 adapter 的错误映射。这里在真实 PostgreSQL 上把每种违例
// 重新造一遍, 拿驱动抛出的原始字段与夹具逐项比对: 库升了主版本、或有人手改了夹具,
// 夹具与真库对不上时在这里变红, 而不是让映射契约对着虚构的输入继续绿

// 每个字段怎么比。exact: 逐字相等; text: 抹掉随运行变化的部分 (进程号、事务号、行位置、
// 撞上的键值) 之后相等。PgErrorFields 新增字段时这里不补就过不了类型检查
const FIELDS: Record<keyof PgErrorFields, 'exact' | 'text'> = {
  severity: 'exact',
  code: 'exact',
  message: 'text',
  detail: 'text',
  hint: 'text',
  where: 'text',
  schema: 'exact',
  table: 'exact',
  column: 'exact',
  constraint: 'exact'
}

const FIELD_NAMES = Object.keys(FIELDS) as (keyof PgErrorFields)[]

const normalize = (text: string) =>
  text.replace(/Key \(([^)]*)\)=\(.*?\)/g, 'Key ($1)=(…)').replace(/\d+/g, 'N')

const presentFields = (source: Partial<Record<keyof PgErrorFields, unknown>>) =>
  FIELD_NAMES.filter((name) => source[name] !== undefined)

// 真库报出的字段集合与夹具相同 (不多不少), 每个字段的值按上表相等
const expectMatchesFixture = (actual: unknown, fixture: PgErrorFields) => {
  expect(actual).toBeInstanceOf(pg.DatabaseError)
  const real = actual as Partial<Record<keyof PgErrorFields, unknown>>

  expect(presentFields(real), '真库报出的字段集合与夹具不一致').toEqual(
    presentFields(fixture)
  )
  for (const name of presentFields(fixture)) {
    if (FIELDS[name] === 'exact') {
      expect(real[name], `字段 ${name}`).toBe(fixture[name])
    } else {
      expect(normalize(String(real[name])), `字段 ${name}`).toBe(
        normalize(String(fixture[name]))
      )
    }
  }
}

// 库里不存在的 id (user 表在用例开始时是空的)
const MISSING_ID = 2147480000

describe.skipIf(!dbContractUrl)('pg error fixtures on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let createdUserIds: number[] = []
  const clients: pg.Client[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
  })

  afterEach(async () => {
    // 先收连接: 失败的用例可能还握着事务与行锁, 不收的话下面的删除会一直等
    await Promise.all(clients.splice(0).map((client) => client.end()))
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    createdUserIds = []
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  // 原生连接: 要的是驱动抛出的原始错误, 不经 adapter。openDbContract 核对过目标库之后才建
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

  const failureOf = (query: Promise<unknown>) =>
    query.then(
      () => {
        throw new Error('语句本该被库拒绝')
      },
      (error: unknown) => error
    )

  const INSERT_CONVERSATION = `
    INSERT INTO user_conversation (user_a_id, user_b_id, updated)
    VALUES ($1, $2, now())`

  const renameOntoTakenName = async () => {
    const [a, b] = [await newUser(), await newUser()]
    const client = await connect()
    return failureOf(
      client.query('UPDATE "user" SET name = $1 WHERE id = $2', [a.name, b.id])
    )
  }

  it('uniqueViolation: 改名撞上别人的名字', async () => {
    expectMatchesFixture(await renameOntoTakenName(), pgErrors.uniqueViolation)
  })

  it('uniqueViolationComposite: 同一对用户的第二个会话', async () => {
    const [a, b] = [await newUser(), await newUser()]
    const client = await connect()
    await client.query(INSERT_CONVERSATION, [a.id, b.id])

    const error = await failureOf(
      client.query(INSERT_CONVERSATION, [a.id, b.id])
    )

    expectMatchesFixture(error, pgErrors.uniqueViolationComposite)
  })

  it('foreignKeyViolation: 会话的另一方不存在', async () => {
    const a = await newUser()
    const client = await connect()

    const error = await failureOf(
      client.query(INSERT_CONVERSATION, [a.id, MISSING_ID])
    )

    expectMatchesFixture(error, pgErrors.foreignKeyViolation)
  })

  it('valueOutOfRange: 给 int4 列绑越界的参数', async () => {
    const client = await connect()

    const error = await failureOf(
      client.query('SELECT id FROM "user" WHERE id = $1', ['2147483648'])
    )

    expectMatchesFixture(error, pgErrors.valueOutOfRange)
  })

  // 两条连接各自先更新一行 (语句返回即已持锁), 再去更新对方那一行。先等 a 确实排在 b 的
  // 行锁上, b 再发第二条, 互等成环; 库在 deadlock_timeout (1 秒) 后回滚其中一方
  it('deadlockDetected: 两个事务按相反的顺序更新同两行', async () => {
    const [u1, u2] = [await newUser(), await newUser()]
    const [a, b, observer] = [await connect(), await connect(), await connect()]
    const update = (client: pg.Client, bio: string, id: number) =>
      client.query('UPDATE "user" SET bio = $1 WHERE id = $2', [bio, id])
    const settled = (query: Promise<unknown>) =>
      query.then(
        () => null,
        (error: unknown) => error
      )

    await a.query('BEGIN')
    await b.query('BEGIN')
    await update(a, 'a', u1.id)
    await update(b, 'b', u2.id)

    const {
      rows: [{ pid }]
    } = await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    const first = settled(update(a, 'a', u2.id))
    for (let i = 0; ; i++) {
      const { rows } = await observer.query<{ wait_event_type: string | null }>(
        'SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1',
        [pid]
      )
      if (rows[0]?.wait_event_type === 'Lock') {
        break
      }
      // 上限要低于用例的超时 (默认 5 秒, 其中死锁检测还要占 1 秒)
      if (i > 100) {
        throw new Error('等了 2 秒, 第一个事务没有进入锁等待')
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const second = settled(update(b, 'b', u1.id))

    // 被回滚的一方先返回错误; 它回滚之后另一方的更新才拿得到锁
    const [firstError, secondError] = await Promise.all([
      first.then(async (error) => {
        await a.query('ROLLBACK')
        return error
      }),
      second.then(async (error) => {
        await b.query('ROLLBACK')
        return error
      })
    ])

    // 恰好一方被选中
    expect([firstError, secondError].filter(Boolean)).toHaveLength(1)
    expectMatchesFixture(firstError ?? secondError, pgErrors.deadlockDetected)
  })

  it('serializationFailure: REPEATABLE READ 下更新已被并发事务改过的行', async () => {
    const user = await newUser()
    const [a, b] = [await connect(), await connect()]

    await a.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    // 第一条语句定下快照
    await a.query('SELECT bio FROM "user" WHERE id = $1', [user.id])
    await b.query('UPDATE "user" SET bio = $1 WHERE id = $2', [
      'changed',
      user.id
    ])
    const error = await failureOf(
      a.query('UPDATE "user" SET bio = $1 WHERE id = $2', ['mine', user.id])
    )
    await a.query('ROLLBACK')

    expectMatchesFixture(error, pgErrors.serializationFailure)
  })

  // 负对照: 比对得认得出过期的夹具
  it('夹具的值变了、少一个字段或多一个字段时, 比对不通过', async () => {
    const real = await renameOntoTakenName()
    const fixture: PgErrorFields = pgErrors.uniqueViolation

    expect(() =>
      expectMatchesFixture(real, { ...fixture, constraint: 'user_email_key' })
    ).toThrow('字段 constraint')
    expect(() =>
      expectMatchesFixture(real, {
        ...fixture,
        message: 'duplicate key value violates unique constraint'
      })
    ).toThrow('字段 message')
    expect(() =>
      expectMatchesFixture(real, { ...fixture, detail: undefined })
    ).toThrow('字段集合')
    expect(() =>
      expectMatchesFixture(real, { ...fixture, column: 'name' })
    ).toThrow('字段集合')
    // 抹掉的只是随运行变化的部分: 键值不同照样相等, 列名不同就不相等
    expectMatchesFixture(real, {
      ...fixture,
      detail: 'Key (name)=(someone-else) already exists.'
    })
    expect(() =>
      expectMatchesFixture(real, {
        ...fixture,
        detail: 'Key (email)=(kun) already exists.'
      })
    ).toThrow('字段 detail')
  })
})
