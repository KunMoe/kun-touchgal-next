import pg from 'pg'
import {
  createKunPrismaClient,
  statementNameGenerator
} from '~/prisma/createClient'
import { isPrismaTransactionConflict } from '~/server/db/txErrors'

// 编译契约测试的录制客户端: 真实的 PrismaClient (查询编译器) + 真实的 @prisma/adapter-pg,
// 底下是一个不开 socket 的 pg.Pool 子类, 逐条记下 adapter 交给驱动的 SQL、参数与语句名。
//
// 守护的是「这段代码依赖编译器的哪个输出」: mock 掉 ~/prisma/index 的单测只锁得住传给
// Prisma 的参数, 锁不住 Prisma 据此发出的 SQL, 也锁不住 adapter 把 pg 错误映射成什么。
// 它不连库, 证明不了库拿到这条 SQL 之后怎么执行 (行锁、并发下的重新求值),
// 那一层由 *.db.test.ts 在真 PostgreSQL 上守护。
//
// 必须是 pg.Pool 的子类: adapter 用 instanceof 认外部池, 认出来才走它真实的参数编码与
// 错误映射。伪造一个 driver adapter 会把这两段一并绕过。
//
// 用法 (vi.mock 的工厂在导入阶段执行, 实例须经 vi.hoisted 提前建好):
//   const recorder = await vi.hoisted(async () =>
//     (await import('~/prisma/__tests__/support/sqlRecorder')).createSqlRecorder()
//   )
//   vi.mock('~/prisma/index', () => recorder.module)
//
// 预置结果只用来把被测代码送上要观察的那条路径 (窄 select 的一行、命中 0 行、驱动报错);
// 业务行为的测试仍用 vi.mock 的惯例或 server/db/__tests__/recordingTransaction.ts。

export interface RecordedStatement {
  // adapter 交给驱动的原文, 不做空白折叠 (语句名由它派生)
  sql: string
  values: unknown[]
  name: string | undefined
  // 0 是连接池的自动提交通道 (pool.query); 每开一个事务取一条新连接, 从 1 起编号
  clientId: number
  // 发出时这条连接上有没有已开始、未结束的事务: BEGIN 本身为 false, COMMIT / ROLLBACK 为 true
  inTransaction: boolean
}

// pg 的 DatabaseError 上 adapter 会读的字段。严重级别、SQLSTATE 与消息缺一不可:
// adapter 靠这三个都是字符串认出「这是数据库报的错」
export interface PgErrorFields {
  severity: string
  code: string
  message: string
  detail?: string
  hint?: string
  where?: string
  schema?: string
  table?: string
  column?: string
  constraint?: string
}

type CannedResult =
  | { rows?: Record<string, unknown>[]; rowCount?: number }
  | { error: PgErrorFields }

interface DriverQuery {
  text: string
  values?: unknown[]
  name?: string
}

type Run = (
  clientId: number,
  query: DriverQuery | string,
  values?: unknown[]
) => Promise<unknown>

const POOL_CLIENT_ID = 0

const { builtins } = pg.types

// 预置行按「驱动解析完线上文本、交给 adapter 之前」的形态回放: int8 是字符串,
// 无时区的 timestamp 是带 +00:00 的 ISO 串 (adapter 自己的解析器产出的样子)
const encodeValue = (value: unknown) => {
  if (value === null) {
    return { dataTypeID: builtins.TEXT, value }
  }
  if (value instanceof Date) {
    return {
      dataTypeID: builtins.TIMESTAMP,
      value: value.toISOString().replace('Z', '+00:00')
    }
  }
  switch (typeof value) {
    case 'boolean':
      return { dataTypeID: builtins.BOOL, value }
    case 'bigint':
      return { dataTypeID: builtins.INT8, value: String(value) }
    case 'number':
      return {
        dataTypeID: Number.isInteger(value) ? builtins.INT4 : builtins.FLOAT8,
        value
      }
    case 'string':
      return { dataTypeID: builtins.TEXT, value }
    default:
      throw new Error(`sqlRecorder: 预置行里有不支持的值 ${String(value)}`)
  }
}

const toDriverResult = (rows: Record<string, unknown>[], rowCount?: number) => {
  const names = Object.keys(rows[0] ?? {})
  return {
    fields: names.map((name) => {
      const sample = rows.find((row) => row[name] !== null)
      return {
        name,
        dataTypeID: sample
          ? encodeValue(sample[name]).dataTypeID
          : builtins.TEXT
      }
    }),
    // adapter 以 rowMode: 'array' 取数
    rows: rows.map((row) => names.map((name) => encodeValue(row[name]).value)),
    rowCount: rowCount ?? rows.length
  }
}

const toDatabaseError = (fields: PgErrorFields) =>
  Object.assign(
    new pg.DatabaseError(fields.message, fields.message.length, 'error'),
    fields
  )

class RecordingClient {
  constructor(
    private readonly id: number,
    private readonly run: Run
  ) {}

  query(query: DriverQuery | string, values?: unknown[]) {
    return this.run(this.id, query, values)
  }

  release() {}

  on() {
    return this
  }

  removeListener() {
    return this
  }
}

class RecordingPool extends pg.Pool {
  private clientSeq = POOL_CLIENT_ID

  constructor(private readonly run: Run) {
    // 这个地址上没有监听者。query 与 connect 都被覆盖, 正常情况下根本不会去连;
    // adapter 哪天改走别的发送路径, 连接会立刻被拒绝, 而不是悄悄连上某个库
    super({ connectionString: 'postgresql://recorder@127.0.0.1:1/recorder' })
  }

  override query(query: any, values?: any): any {
    return this.run(POOL_CLIENT_ID, query, values)
  }

  override connect(): any {
    return Promise.resolve(new RecordingClient(++this.clientSeq, this.run))
  }
}

export const createSqlRecorder = () => {
  let statements: RecordedStatement[] = []
  const replies: Array<{ pattern: RegExp; results: CannedResult[] }> = []
  const openTransactions = new Set<number>()

  const run: Run = async (clientId, query, values) => {
    const { text, ...rest } =
      typeof query === 'string' ? { text: query, values } : query

    statements.push({
      sql: text,
      values: [...(rest.values ?? [])],
      name: rest.name,
      clientId,
      inTransaction: openTransactions.has(clientId)
    })
    if (text === 'BEGIN') {
      openTransactions.add(clientId)
    } else if (text === 'COMMIT' || text === 'ROLLBACK') {
      openTransactions.delete(clientId)
    }

    const collapsed = text.replace(/\s+/g, ' ').trim()
    const canned = replies
      .find(({ pattern, results }) => results.length && pattern.test(collapsed))
      ?.results.shift()
    if (!canned) {
      // 没有预置时: 读回空集, 写报告影响 1 行
      return toDriverResult([], /^(SELECT|WITH)\b/i.test(collapsed) ? 0 : 1)
    }
    if ('error' in canned) {
      throw toDatabaseError(canned.error)
    }
    return toDriverResult(canned.rows ?? [], canned.rowCount)
  }

  const prisma = createKunPrismaClient(new RecordingPool(run))

  return {
    prisma,

    // ~/prisma/index 的替身: 导出与真模块逐项对应 (少一项过不了类型检查)
    module: {
      prisma,
      isPrismaTransactionConflict,
      statementNameGenerator
    } satisfies typeof import('~/prisma/index'),

    // 给匹配到的语句预置结果。pattern 对折叠空白后的 SQL 求值; 同一个 pattern 的多个结果
    // 按先后各用一次, 用完之后回到默认
    reply(pattern: RegExp, ...results: CannedResult[]) {
      replies.push({ pattern, results })
    },

    // 取走自上次 take / reset 以来录到的语句。一条都没有就抛错: adapter 换了发送路径、
    // 或被测代码根本没走到 Prisma 时, 断言不能在空数组上空转而照样通过
    take() {
      if (statements.length === 0) {
        throw new Error('sqlRecorder: 没有录到任何语句')
      }
      const taken = statements
      statements = []
      return taken
    },

    reset() {
      statements = []
      replies.length = 0
      openTransactions.clear()
    }
  }
}
