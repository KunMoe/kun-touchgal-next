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

// 事务级通告锁在真实 PostgreSQL 上的样子 (运行方式见 server/db/__tests__/dbContract.ts)。
// 四个点赞 / 收藏 toggle、评分统计、patch type 重算都靠同一种写法串行化:
// pg_advisory_xact_lock(域::int, id::int)。它们的单测全是 mock, 证明不了锁到底有没有拿到、
// 拿的是哪个重载、持有到什么时候、后来者是不是真的在等。这里拿收藏 toggle 当金丝雀,
// 从路由入口驱动, 在 pg_locks (谁拿着、谁在等哪把锁) 与 pg_stat_activity (各会话停在哪条
// 语句上) 里看。pg_locks 分不出事务级与会话级的锁, 「事务级」 是从两件事合起来看的:
// 事务中途锁还在, 提交之后连接还开着而锁没了

const { verifyHeaderCookieMock } = vi.hoisted(() => ({
  verifyHeaderCookieMock: vi.fn()
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

// 两份缓存都在 Redis 里, 与这里要看的事无关
vi.mock('~/app/api/patch/cache', () => ({
  invalidatePatchFavoriteCache: vi.fn(),
  invalidatePatchContentCache: vi.fn()
}))

vi.mock('~/app/api/message/unread/cache', () => ({
  invalidateUnread: vi.fn(() => Promise.resolve())
}))

// 收藏 toggle 的锁域 (路由里的 FAVORITE_LOCK_NAMESPACE)。迁移执行器
// (scripts/db/lib/runtime.ts) 也按 481001~481004 避让, 这个数是跨模块的约定
const FAVORITE_LOCK_NAMESPACE = 481003

interface AdvisoryLock {
  pid: number
  classid: number
  objid: number
  objsubid: number
  mode: string
  granted: boolean
}

interface LockWaiter {
  pid: number
  wait_event: string | null
  query: string
}

describe.skipIf(!dbContractUrl)('favorite toggle on real PostgreSQL', () => {
  let prisma: Awaited<ReturnType<typeof openDbContract>>
  let PUT: typeof import('~/app/api/patch/favorite/route').PUT
  let kunTx: typeof import('~/server/db/tx').kunTx
  let createdUserIds: number[] = []
  const clients: pg.Client[] = []

  beforeAll(async () => {
    prisma = await openDbContract()
    ;({ PUT } = await import('~/app/api/patch/favorite/route'))
    ;({ kunTx } = await import('~/server/db/tx'))
  })

  afterEach(async () => {
    // 先收连接: 失败的用例可能还握着锁, 不收的话下面的删除会一直等
    await Promise.all(clients.splice(0).map((client) => client.end()))
    // Galgame、收藏夹、收藏关系、通知都随 user 级联
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

  // 空库里各张表的自增 id 都从 1 起, 收藏夹 id 很容易与用户 id、Galgame id 撞上;
  // 撞上的话 「锁键是收藏夹 id」 这条断言分不清键是不是取错了列, 所以避开
  const newFolder = async (userId: number, avoid: number[]) => {
    for (;;) {
      // 公开收藏夹: 收藏进私密收藏夹不给作者发通知, 这里数的是通知
      const folder = await prisma.user_patch_favorite_folder.create({
        data: { name: randomUUID(), user_id: userId, is_public: true }
      })
      if (!avoid.includes(folder.id)) {
        return folder
      }
    }
  }

  // Galgame 属于 owner, 收藏的是 fan: 两人不同才会发通知
  const newScene = async () => {
    const [owner, fan] = [await newUser(), await newUser()]
    const patch = await prisma.patch.create({
      data: {
        unique_id: randomUUID().slice(0, 8),
        name: 'favorite lock canary',
        user_id: owner.id
      }
    })
    const taken = [owner.id, fan.id, patch.id]
    const folder = await newFolder(fan.id, taken)
    const otherFolder = await newFolder(fan.id, [...taken, folder.id])
    verifyHeaderCookieMock.mockResolvedValue({ uid: fan.id })
    return { owner, fan, patch, folder, otherFolder }
  }

  const toggle = async (folderId: number, patchId: number) => {
    const request = new Request('http://localhost/api/patch/favorite', {
      method: 'PUT',
      body: JSON.stringify({ patchId, folderId })
    }) as unknown as Parameters<typeof PUT>[0]
    const response = await PUT(request)
    return response.json() as Promise<unknown>
  }

  const favoritesIn = (folderId: number) =>
    prisma.user_patch_favorite_folder_relation.count({
      where: { folder_id: folderId }
    })

  const noticesFor = (folderId: number) =>
    prisma.user_message.count({
      where: { type: 'favorite', link: { endsWith: `?folderId=${folderId}` } }
    })

  // 本库里的通告锁。两个 int 键的重载: classid 是第一个键, objid 是第二个, objsubid 为 2;
  // 单个 bigint 键的重载是 classid 高 32 位、objid 低 32 位、objsubid 为 1
  const advisoryLocks = async (observer: pg.Client) => {
    const { rows } = await observer.query<AdvisoryLock>(
      `SELECT pid, classid::int4 AS classid, objid::int4 AS objid,
              objsubid::int4 AS objsubid, mode, granted
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND database = (
           SELECT oid FROM pg_database WHERE datname = current_database()
         )
       ORDER BY granted DESC, pid`
    )
    return rows
  }

  // 等到恰有 expected 个会话排在锁上。观察用的连接不开事务: pg_stat_activity 在同一个事务
  // 里读到的是第一次读取时的快照
  const waitForLockWaiters = async (observer: pg.Client, expected: number) => {
    const sessions = () =>
      observer.query<LockWaiter & { wait_event_type: string | null }>(
        `SELECT pid, wait_event_type, wait_event, left(query, 80) AS query
         FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()`
      )
    for (let i = 0; ; i++) {
      const { rows } = await sessions()
      const waiting = rows.filter((row) => row.wait_event_type === 'Lock')
      if (waiting.length === expected) {
        return waiting.map(({ pid, wait_event, query }) => ({
          pid,
          wait_event,
          query
        }))
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

  // 锁闸门: 另一条连接先占住 gate 指的那把锁, 等 fire 发出的请求全都排在锁上, 看完现场
  // (whileHeld) 再放行。于是这些请求确实是重叠的, 结果只取决于库怎么排它们
  const raceBehind = async <T>(
    gate: { text: string; values: number[] },
    fire: () => Promise<T>[],
    whileHeld: (
      waiters: LockWaiter[],
      observer: pg.Client
    ) => Promise<void> = async () => undefined
  ) => {
    const [holder, observer] = [await connect(), await connect()]
    await holder.query('BEGIN')
    await holder.query(gate.text, gate.values)

    const pending = fire()
    const settled = Promise.allSettled(pending)
    try {
      const waiters = await waitForLockWaiters(observer, pending.length)
      await whileHeld(waiters, observer)
    } finally {
      await holder.query('COMMIT')
      await settled
    }
    return { results: await Promise.all(pending), observer }
  }

  // 占住收藏夹这一行: 收藏关系的 INSERT 要对它做外键检查 (FOR KEY SHARE), 会停在这里。
  // 用来把一个已经拿到通告锁的 toggle 冻在事务中途
  const folderRowGate = (folderId: number) => ({
    text: 'SELECT 1 FROM user_patch_favorite_folder WHERE id = $1 FOR UPDATE',
    values: [folderId]
  })

  it('toggle 拿的是 (481003, 收藏夹 id) 两个 int 键的通告锁: 事务走到后面的语句时仍在手里, 提交后连接上不留锁; 同一收藏夹的后来者排在它上面, 别的收藏夹不受牵连', async () => {
    const { patch, folder, otherFolder } = await newScene()
    const key = {
      classid: FAVORITE_LOCK_NAMESPACE,
      objid: folder.id,
      objsubid: 2,
      mode: 'ExclusiveLock'
    }

    const { results, observer } = await raceBehind(
      folderRowGate(folder.id),
      () => [toggle(folder.id, patch.id), toggle(folder.id, patch.id)],
      async (waiters, observer) => {
        const locks = await advisoryLocks(observer)
        expect(locks.map(({ pid: _pid, ...lock }) => lock)).toEqual([
          { ...key, granted: true },
          { ...key, granted: false }
        ])

        // 拿到锁的会话已经走到事务里后面的语句 (停在闸门占着的行上), 锁仍在它手里:
        // 锁不是随取锁那条语句结束的。另一个会话等的正是这把通告锁
        const [granted, queued] = locks.map(({ pid }) =>
          waiters.find((waiter) => waiter.pid === pid)
        )
        expect(granted).toMatchObject({
          wait_event: expect.not.stringMatching(/^advisory$/),
          query: expect.not.stringContaining('pg_advisory_xact_lock')
        })
        expect(queued).toMatchObject({
          wait_event: 'advisory',
          query: expect.stringContaining('pg_advisory_xact_lock')
        })

        // 锁键细到收藏夹: 同一用户、同一 Galgame 在另一个收藏夹上的 toggle 不用等。
        // 这一步若超时, 先看被冻住的那个 toggle 是不是已经写过 Galgame 这一行: 它停在
        // 外键检查上, 而收藏数的触发器排在外键检查之后 (触发器按名字的字节序执行,
        // RI_ConstraintTrigger_* 在 patch_favorite_count_trg 之前), 所以此刻还没有动那一行
        await expect(toggle(otherFolder.id, patch.id)).resolves.toEqual({
          added: true,
          isFavorite: true
        })
      }
    )

    // 后来者等到先行者提交才拿到锁, 所以读到了那一行并把它删掉: 双击回到原状。
    // isFavorite 是跨收藏夹的聚合, 另一个夹里还有, 所以仍为 true
    expect(results).toHaveLength(2)
    expect(results).toContainEqual({ added: true, isFavorite: true })
    expect(results).toContainEqual({ added: false, isFavorite: true })
    await expect(favoritesIn(folder.id)).resolves.toBe(0)
    await expect(noticesFor(folder.id)).resolves.toBe(0)
    await expect(favoritesIn(otherFolder.id)).resolves.toBe(1)

    // 事务结束锁就没了。池里的连接都还开着, 会话级的锁会留在这里
    await expect(advisoryLocks(observer)).resolves.toEqual([])
  })

  it('同一 (收藏夹, Galgame) 上 5 个并发 toggle 都排在手工占住的同一把锁后面, 放行后逐个交替: 3 次收藏 2 次取消, 留下一行、一条通知', async () => {
    const { patch, folder } = await newScene()

    // 闸门就是这把锁本身, 按 (int, int) 的写法手工占住。应用取的若不是同一把
    // (域不对、键不对、走了 bigint 的重载), 这 5 个请求不会排在它后面
    const { results } = await raceBehind(
      {
        text: 'SELECT pg_advisory_xact_lock($1::int, $2::int)',
        values: [FAVORITE_LOCK_NAMESPACE, folder.id]
      },
      () => Array.from({ length: 5 }, () => toggle(folder.id, patch.id)),
      async (waiters) => {
        expect(waiters.map((waiter) => waiter.wait_event)).toEqual(
          Array.from({ length: 5 }, () => 'advisory')
        )
      }
    )

    const added = { added: true, isFavorite: true }
    const removed = { added: false, isFavorite: false }
    expect(results.filter((result) => typeof result === 'string')).toEqual([])
    expect(
      results.filter((result) => (result as { added: boolean }).added)
    ).toEqual([added, added, added])
    expect(
      results.filter((result) => !(result as { added: boolean }).added)
    ).toEqual([removed, removed])
    await expect(favoritesIn(folder.id)).resolves.toBe(1)
    await expect(noticesFor(folder.id)).resolves.toBe(1)
  })

  // 负对照: 同样的两步 (deleteMany + createMany skipDuplicates), 只是不拿通告锁, 放进与
  // 第一条用例相同的闸门。两个事务都没读到对方的行, 都去插入, 后到的那个被 ON CONFLICT
  // 吞掉: 两次都报 「已收藏」, 双击没有回到原状。skipDuplicates 只保证不抛 P2002,
  // 可线性化是那把锁给的
  it('不拿锁的同一套写法在同样的并发下: 两个 toggle 都报收藏成功, 留下一行', async () => {
    const { patch, folder } = await newScene()

    const toggleWithoutLock = () =>
      kunTx('favorite.toggle.unlocked', async ({ tx }) => {
        const removed = await tx.user_patch_favorite_folder_relation.deleteMany(
          { where: { folder_id: folder.id, patch_id: patch.id } }
        )
        if (removed.count > 0) {
          return { added: false }
        }
        await tx.user_patch_favorite_folder_relation.createMany({
          data: { folder_id: folder.id, patch_id: patch.id },
          skipDuplicates: true
        })
        return { added: true }
      })

    const { results } = await raceBehind(folderRowGate(folder.id), () => [
      toggleWithoutLock(),
      toggleWithoutLock()
    ])

    expect(results).toEqual([{ added: true }, { added: true }])
    await expect(favoritesIn(folder.id)).resolves.toBe(1)
  })
})
