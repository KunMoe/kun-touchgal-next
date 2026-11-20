import { isMainThread } from 'worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqlRecorder } from '~/prisma/__tests__/support/sqlRecorder'
import {
  dataStatements,
  expectAggregatePushdown,
  expectEscapedIlike,
  expectFlatConditionalUpdate,
  expectSameClientTransaction,
  expectSingleDeleteReturning,
  expectStatementNames,
  wholeTableAggregates
} from '~/prisma/__tests__/support/sqlShape'

// 编译契约: 应用代码依赖的那几条「Prisma 把这种参数形状编译成什么 SQL」。
// 这是对第三方编译器输出的契约测试, 不是在测自己的实现细节: 被依赖的输出只写在注释和
// 口头约定里时, 升级 prisma / @prisma/adapter-pg / pg 之后没有东西会提醒人去复验。
// 这里不连库 (见 support/sqlRecorder.ts); 各站点自己的调用由同目录外的 *.sql.test.ts 驱动。
//
// 变红时: 先判断新形状是否仍满足用例标题写的前提, 满足才改断言; 不满足就得改用到它的代码。

const recorder = createSqlRecorder()
const { prisma } = recorder

beforeEach(() => {
  recorder.reset()
})

describe('录制客户端', () => {
  it('自动提交的调用走连接池, 事务里的调用连同 BEGIN / COMMIT 走同一条取出的连接', async () => {
    await prisma.user.findFirst({ where: { id: 1 }, select: { id: true } })
    const [read] = recorder.take()
    expect(read).toMatchObject({ clientId: 0, inTransaction: false })

    await prisma.$transaction(async (tx) => {
      await tx.user.findFirst({ where: { id: 1 }, select: { id: true } })
    })
    const inTx = recorder.take()
    expect(inTx.map(({ sql }) => sql.split(' ')[0])).toEqual([
      'BEGIN',
      'SELECT',
      'COMMIT'
    ])
    expect(new Set(inTx.map(({ clientId }) => clientId)).size).toBe(1)
    expect(inTx[0].clientId).not.toBe(0)
    expect(inTx.map(({ inTransaction }) => inTransaction)).toEqual([
      false,
      true,
      true
    ])
    // 数「发了几条语句」时不算事务控制语句
    expect(dataStatements(inTx)).toEqual([inTx[1]])
  })

  it('一条语句都没录到时 take 抛错, 断言不会在空集合上通过', () => {
    expect(() => recorder.take()).toThrow('没有录到任何语句')
  })

  // 驱动把线上文本解析成值的那一步是录制器模拟的 (见 sqlRecorder.ts 的 encodeValue);
  // 之后的列类型映射与反序列化是真实的
  it('预置的行经 adapter 的列类型映射与客户端的反序列化回到调用方', async () => {
    const registered = new Date('2026-01-02T03:04:05.678Z')
    recorder.reply(/FROM "public"\."user"/, {
      rows: [{ id: 7, name: 'kun', register_time: registered }]
    })

    await expect(
      prisma.user.findFirst({
        where: { id: 7 },
        select: { id: true, name: true, register_time: true }
      })
    ).resolves.toEqual({ id: 7, name: 'kun', register_time: registered })
  })
})

describe('条件更新 (CAS)', () => {
  it('标量条件的 updateMany 只发一条 UPDATE (没有先读后写), 守卫平铺在它自己的 WHERE 里', async () => {
    const result = await prisma.user.updateMany({
      where: { id: 42, daily_check_in: 0 },
      data: { moemoepoint: { increment: 5 }, daily_check_in: { set: 1 } }
    })

    const statements = recorder.take()
    expect(dataStatements(statements)).toHaveLength(1)
    expectFlatConditionalUpdate(statements, {
      table: 'user',
      guards: ['id', 'daily_check_in']
    })
    expect(result).toEqual({ count: 1 })
  })

  it('count 取自这条 UPDATE 影响的行数: 库报告 0 行时 count 为 0', async () => {
    recorder.reply(/^UPDATE/, { rowCount: 0 })

    await expect(
      prisma.user.updateMany({
        where: { id: 42, daily_check_in: 0 },
        data: { daily_check_in: { set: 1 } }
      })
    ).resolves.toEqual({ count: 0 })
  })

  it('比较条件 (gte / not) 同样平铺', async () => {
    await prisma.user.updateMany({
      where: { id: 42, moemoepoint: { gte: 30 }, name: { not: 'kun' } },
      data: { name: 'kun', moemoepoint: { increment: -30 } }
    })

    expectFlatConditionalUpdate(recorder.take(), {
      table: 'user',
      guards: ['id', 'moemoepoint', 'name']
    })
  })

  it('事务里的条件更新与 BEGIN / COMMIT 同一条连接, 形状不变', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { id: 42, moemoepoint: { gte: 20 } },
        data: { moemoepoint: { decrement: 10 } }
      })
    })

    const statements = recorder.take()
    expectSameClientTransaction(statements, [/^UPDATE "public"\."user"/])
    expectFlatConditionalUpdate(statements, {
      table: 'user',
      guards: ['id', 'moemoepoint']
    })
  })

  // 负对照: 断言得认得出危险形状。关系过滤会被编译成 EXISTS 子查询, 并发下库不重新求值它
  it('关系过滤的 updateMany 被编译成子查询, 断言判它不是平铺的条件更新', async () => {
    await prisma.patch_resource.updateMany({
      where: { id: 7, status: 2, patch: { status: 0 } },
      data: { status: 0 }
    })

    const statements = recorder.take()
    expect(statements[0].sql).toContain('EXISTS')
    expect(() =>
      expectFlatConditionalUpdate(statements, {
        table: 'patch_resource',
        guards: ['id', 'status']
      })
    ).toThrow('子查询')
  })

  it('同一张表上不止一条 UPDATE 时断言不通过', async () => {
    const claim = () =>
      prisma.user.updateMany({
        where: { id: 42, daily_check_in: 0 },
        data: { daily_check_in: { set: 1 } }
      })
    await claim()
    await claim()

    expect(() =>
      expectFlatConditionalUpdate(recorder.take(), {
        table: 'user',
        guards: ['id', 'daily_check_in']
      })
    ).toThrow('恰好有一条')
  })

  it('守卫与别的条件 OR 在一起时断言不通过', async () => {
    await prisma.user.updateMany({
      where: { OR: [{ id: 42 }, { daily_check_in: 0 }] },
      data: { daily_check_in: { set: 1 } }
    })

    expect(() =>
      expectFlatConditionalUpdate(recorder.take(), {
        table: 'user',
        guards: ['id', 'daily_check_in']
      })
    ).toThrow('合取条件')
  })

  it('守卫列不在 WHERE 里时断言不通过', async () => {
    await prisma.user.updateMany({
      where: { id: 42 },
      data: { daily_check_in: { set: 1 } }
    })

    expect(() =>
      expectFlatConditionalUpdate(recorder.take(), {
        table: 'user',
        guards: ['id', 'daily_check_in']
      })
    ).toThrow('daily_check_in')
  })
})

describe('删除', () => {
  // 只作记录: 两处资源删除已改为先 FOR UPDATE 再删, 不再依赖「返回值即删除瞬间的行」。
  // 变红时直接按新形状改断言即可
  it('delete 是单条 DELETE … RETURNING', async () => {
    await prisma.patch_resource.delete({ where: { id: 7 } }).catch(() => null)

    expectSingleDeleteReturning(recorder.take(), 'patch_resource')
  })
})

describe('大小写不敏感的精确匹配', () => {
  // insensitiveEquals 存在的理由。Prisma 哪天自己转义了, 这条会红: 那时 helper 要删掉,
  // 否则转义两层, 带 _ 或 % 的用户名与邮箱再也查不到
  it('equals + insensitive 被编译成不带 ESCAPE 的 ILIKE, 参数原样绑定, _ 和 % 是通配符', async () => {
    await prisma.user.findFirst({
      where: { name: { equals: 'a_b%c', mode: 'insensitive' } },
      select: { id: true }
    })

    const statements = recorder.take()
    expectEscapedIlike(statements, { column: 'name', bound: 'a_b%c' })
    // 负对照: 绑定的不是所要求的那个串时断言不通过
    expect(() =>
      expectEscapedIlike(statements, { column: 'name', bound: 'a\\_b\\%c' })
    ).toThrow()
    // 负对照: 带了 ESCAPE 子句就不再是「反斜杠转义」那套前提
    const [{ sql, values }] = statements
    expect(() =>
      expectEscapedIlike(
        [
          {
            ...statements[0],
            sql: sql.replace('ILIKE $1', "ILIKE $11 ESCAPE '!'"),
            values: [...values, ...Array(10).fill('a_b%c')]
          }
        ],
        { column: 'name', bound: 'a_b%c' }
      )
    ).toThrow('没有找到')
  })

  it('同一列上有多处 ILIKE 时逐处核对绑定值', async () => {
    await prisma.user.findFirst({
      where: {
        OR: [
          { name: { equals: 'first', mode: 'insensitive' } },
          { name: { equals: 'second', mode: 'insensitive' } }
        ]
      },
      select: { id: true }
    })

    expect(() =>
      expectEscapedIlike(recorder.take(), { column: 'name', bound: 'first' })
    ).toThrow()
  })
})

describe('关系 _count', () => {
  const likes = {
    relationTable: 'user_patch_comment_like_relation',
    parentTable: 'patch_comment',
    predicateColumn: 'patch_id'
  }
  const likeCount = (like_by: true | { where: object }) =>
    prisma.patch_comment.findMany({
      where: { patch_id: 9 },
      take: 2,
      select: { id: true, _count: { select: { like_by } } }
    })

  it('带上对返回行恒真的关系过滤时, 条件下推进聚合子查询', async () => {
    await likeCount({ where: { comment: { patch_id: 9 } } })

    const statements = recorder.take()
    expectAggregatePushdown(statements, likes)
    expect(wholeTableAggregates(statements)).toEqual([])
  })

  // 负对照: 外层的 patch_id 条件下推不进聚合子查询, 不带过滤就是整表 GROUP BY
  it('不带过滤时聚合子查询没有任何条件, 断言判它为整表聚合', async () => {
    await likeCount(true)

    const statements = recorder.take()
    expect(wholeTableAggregates(statements)).toEqual([likes.relationTable])
    expect(() => expectAggregatePushdown(statements, likes)).toThrow(
      '整表 GROUP BY'
    )
  })

  // 负对照: 落在点赞表自己的列上的条件改变的是数出来的结果 (只数某个人点的赞), 不是恒真过滤
  it('过滤落在子表自己的列上时不算下推', async () => {
    await likeCount({ where: { user_id: 9 } })

    expect(() =>
      expectAggregatePushdown(recorder.take(), {
        ...likes,
        predicateColumn: 'user_id'
      })
    ).toThrow('整表 GROUP BY')
  })

  // 负对照: 条件在另一张连接进来的表上, 不是所声明的父表
  it('过滤落在别的连接表上时不算所声明的下推', async () => {
    await likeCount({ where: { comment: { patch: { user_id: 9 } } } })

    const statements = recorder.take()
    expect(statements[0].sql).toMatch(/"user_id" = \$\d+/)
    expect(() =>
      expectAggregatePushdown(statements, {
        ...likes,
        predicateColumn: 'user_id'
      })
    ).toThrow('整表 GROUP BY')
  })

  // 负对照: 与别的条件 OR 在一起的过滤限制不了聚合的范围
  it('过滤被 OR 进别的条件时不算下推', async () => {
    await likeCount({
      where: { OR: [{ comment: { patch_id: 9 } }, { user_id: 1 }] }
    })

    const statements = recorder.take()
    expect(() => expectAggregatePushdown(statements, likes)).toThrow(
      '整表 GROUP BY'
    )
    expect(wholeTableAggregates(statements)).toEqual([likes.relationTable])
  })

  // 负对照: 只有等值条件才把聚合限制在相关的行上
  it('聚合子查询只带范围条件时仍判为整表聚合', async () => {
    await likeCount({ where: { id: { gt: 0 } } })

    expect(wholeTableAggregates(recorder.take())).toEqual([likes.relationTable])
  })
})

describe('事务级通告锁', () => {
  // 这里只能证明锁与后续写入发在同一条连接、同一个事务里, 且两个参数以整数绑定
  // (::int 的两参数重载); 锁是否真的互斥、是否持有到提交要在真库上看
  it('$executeRaw 的通告锁与 BEGIN / COMMIT 以及随后的写入在同一条连接上', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${481003}::int, ${5}::int)`
      await tx.user_patch_favorite_folder_relation.deleteMany({
        where: { folder_id: 5, patch_id: 9 }
      })
    })

    const [lock] = expectSameClientTransaction(recorder.take(), [
      /^SELECT pg_advisory_xact_lock\(\$1::int, \$2::int\)$/,
      /^DELETE FROM "public"\."user_patch_favorite_folder_relation"/
    ])
    expect(lock.values).toEqual([481003, 5])
  })

  // 负对照: 回调里误用了全局的 prisma 而不是 tx, 锁就取在另一条连接上, 语句结束即释放
  it('通告锁没有发在事务的连接上时断言不通过', async () => {
    await prisma.$transaction(async (tx) => {
      await prisma.$executeRaw`SELECT pg_advisory_xact_lock(${481003}::int, ${5}::int)`
      await tx.user_patch_favorite_folder_relation.deleteMany({
        where: { folder_id: 5, patch_id: 9 }
      })
    })

    expect(() =>
      expectSameClientTransaction(recorder.take(), [
        /^SELECT pg_advisory_xact_lock/
      ])
    ).toThrow('事务里没有按顺序找到')
  })

  it('事务里的语句出错时 ROLLBACK 发在同一条连接上', async () => {
    recorder.reply(/^DELETE/, {
      error: { severity: 'ERROR', code: 'XX000', message: 'boom' }
    })

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user_patch_favorite_folder_relation.deleteMany({
          where: { folder_id: 5 }
        })
      })
    ).rejects.toThrow()

    const statements = recorder.take()
    expect(statements.map(({ sql }) => sql.split(' ')[0])).toEqual([
      'BEGIN',
      'DELETE',
      'ROLLBACK'
    ])
    expect(new Set(statements.map(({ clientId }) => clientId)).size).toBe(1)
    // 负对照: 回滚掉的事务不满足「同一连接上的已提交事务」
    expect(() => expectSameClientTransaction(statements, [])).toThrow(
      '没有以 COMMIT 结束'
    )
  })
})

describe('参数编码', () => {
  describe('时间', () => {
    beforeEach(() => {
      // 进程时区不是 UTC 时才分得清「UTC 墙钟」与「本地墙钟」; CI 的时区是 UTC
      vi.stubEnv('TZ', 'Asia/Shanghai')
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-20T01:02:03.004Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllEnvs()
    })

    // 全库的时间列是无时区的 timestamp, 约定存 UTC 墙钟; 靠的是 adapter 把 Date 格式化成
    // 不带偏移的 UTC 时间串, 库的会话时区才无关紧要。
    // worker 线程里改 TZ 不生效, 所以 --pool=threads 下跳过 (默认的 forks 池在主线程里跑)
    it.skipIf(!isMainThread)(
      'Date 参数与 @updatedAt 以不带偏移的 UTC 墙钟字符串绑定, 与进程时区无关',
      async () => {
        expect(new Date().getTimezoneOffset()).toBe(-480)

        await prisma.user.updateMany({
          where: {
            id: 42,
            register_time: { lt: new Date('2026-11-19T23:59:59.500Z') }
          },
          data: { bio: '' }
        })
        const [update] = recorder.take()
        // 条件里的 Date 参数, 以及 @updatedAt 取的当前时间
        expect(update.values).toContain('2026-11-19 23:59:59.500')
        expect(update.values).toContain('2026-11-20 01:02:03.004')

        const since = new Date('2026-11-19T16:00:00.250Z')
        await prisma.$executeRaw`DELETE FROM moderation_task WHERE next_attempt < ${since}`
        const [raw] = recorder.take()
        expect(raw.values).toEqual(['2026-11-19 16:00:00.250'])
      }
    )
  })

  // 库里的 id 都是 int4。越界的整数不在客户端被拦下, 原样发给库, 由库以 22003 拒绝
  // (映射见 error-contract.test.ts); 所以用户输入要在 Zod 层卡住上界
  it('超出 int4 的整数原样发给库', async () => {
    await prisma.user.findUnique({
      where: { id: 2147483648 },
      select: { id: true }
    })

    expect(Number(recorder.take()[0].values[0])).toBe(2147483648)
  })

  // 小数既不报错也不是「查不到」: 它被截成整数去查, 5.5 会命中 id 为 5 的行。
  // 拿用户输入当 id 的入口必须自己拒绝小数 (z.number().int())
  it('Int 参数里的小数被截断成整数发给库', async () => {
    await prisma.user.findUnique({ where: { id: 5.5 }, select: { id: true } })

    expect(Number(recorder.take()[0].values[0])).toBe(5)
  })
})

describe('语句名', () => {
  it('模型调用、原生语句与事务控制语句都带着由自身文本派生的名字', async () => {
    await prisma.user.findFirst({ where: { id: 1 }, select: { id: true } })
    await prisma.$queryRaw`SELECT id FROM patch WHERE id = ${1}`
    await prisma.$transaction(async (tx) => {
      await tx.user.updateMany({ where: { id: 1 }, data: { bio: '' } })
    })

    const statements = recorder.take()
    expect(statements.map(({ sql }) => sql)).toContain('BEGIN')
    expectStatementNames(statements)
    // 负对照: 有一条没带名字、或带的不是由它自己的文本派生的名字, 都不通过
    expect(() =>
      expectStatementNames([{ ...statements[0], name: undefined }])
    ).toThrow('没有带上派生的名字')
    expect(() =>
      expectStatementNames([{ ...statements[0], name: statements[1].name }])
    ).toThrow('没有带上派生的名字')
  })
})
