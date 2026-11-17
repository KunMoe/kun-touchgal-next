import { isPrismaTransactionConflict } from '~/server/db/txErrors'

// 记录型的 prisma 假对象: 逐条记下模型调用与原生 SQL (含取锁语句), 按事务尝试分组,
// 并标出每次尝试是提交还是回滚。命令测试据此断言「锁 → 清理 → 删除」的语句顺序,
// 不必逐个方法手写 mock。
//
// 读 (find* / count / aggregate / $queryRaw) 是被测代码的输入, 必须先用 on / onRaw 配好,
// 没配就抛错: 默认回空会让守卫类用例在「行不存在」的分支上空转而照样通过。
// 写只是输出, 没配时回一个中性值 ({ count: 0 } / {} / 0) 并照常记录。
//
// 用法 (vi.mock 的工厂在导入阶段执行, 实例须经 vi.hoisted 提前建好):
//   const rec = await vi.hoisted(async () =>
//     (await import('~/server/db/__tests__/recordingTransaction')).recordingTransaction()
//   )
//   vi.mock('~/prisma/index', () => rec.module)

export interface RecordedStatement {
  // 模型调用是 'patch_comment.deleteMany'; 原生 SQL 是 '$queryRaw: SELECT … FOR UPDATE'
  label: string
  // 模型调用的入参, 或原生 SQL 展平后的参数表
  args: unknown
}

export interface RecordedAttempt {
  committed: boolean
  rolledBack: boolean
  options: unknown
  statements: RecordedStatement[]
}

type Handler = (args: any) => unknown
type RawHandler = (values: unknown[], sql: string) => unknown

const READ_METHODS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy'
])

const NEUTRAL_WRITE_RESULT: Record<string, unknown> = {
  createMany: { count: 0 },
  updateMany: { count: 0 },
  deleteMany: { count: 0 }
}

const isSql = (
  value: unknown
): value is { strings: string[]; values: unknown[] } =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { strings?: unknown }).strings) &&
  Array.isArray((value as { values?: unknown }).values)

// 把模板串与内嵌的 Prisma.sql / Prisma.join 片段展平成「? 占位的 SQL + 参数表」
const flattenSql = (strings: readonly string[], values: unknown[]) => {
  let sql = strings[0]
  const flat: unknown[] = []
  values.forEach((value, index) => {
    if (isSql(value)) {
      const nested = flattenSql(value.strings, value.values)
      sql += nested.sql
      flat.push(...nested.values)
    } else {
      sql += '?'
      flat.push(value)
    }
    sql += strings[index + 1]
  })
  return { sql: sql.replace(/\s+/g, ' ').trim(), values: flat }
}

export const recordingTransaction = () => {
  const attempts: RecordedAttempt[] = []
  // 事务之外的调用 (入口的预检、管理员查询等)
  const outside: RecordedStatement[] = []
  const handlers = new Map<string, Handler>()
  const rawHandlers: Array<{ pattern: RegExp; handler: RawHandler }> = []

  const runModel = async (
    sink: RecordedStatement[],
    model: string,
    method: string,
    args: unknown
  ) => {
    const label = `${model}.${method}`
    sink.push({ label, args })
    const handler = handlers.get(label)
    if (handler) {
      return handler(args)
    }
    if (READ_METHODS.has(method)) {
      throw new Error(`recordingTransaction: 未配置读取 ${label}`)
    }
    return NEUTRAL_WRITE_RESULT[method] ?? {}
  }

  const runRaw = async (
    sink: RecordedStatement[],
    method: '$queryRaw' | '$executeRaw',
    strings: readonly string[],
    values: unknown[]
  ) => {
    const flat = flattenSql(strings, values)
    sink.push({ label: `${method}: ${flat.sql}`, args: flat.values })
    const matched = rawHandlers.find(({ pattern }) => pattern.test(flat.sql))
    if (matched) {
      return matched.handler(flat.values, flat.sql)
    }
    if (method === '$queryRaw') {
      throw new Error(`recordingTransaction: 未配置查询 ${flat.sql}`)
    }
    return 0
  }

  const clientOf = (sink: () => RecordedStatement[]) =>
    new Proxy(
      {},
      {
        get(_target, model) {
          if (typeof model !== 'string' || model === 'then') {
            return undefined
          }
          if (model === '$queryRaw' || model === '$executeRaw') {
            return (strings: readonly string[], ...values: unknown[]) =>
              runRaw(sink(), model, strings, values)
          }
          return new Proxy(
            {},
            {
              get(_inner, method) {
                if (typeof method !== 'string') {
                  return undefined
                }
                return (args?: unknown) => runModel(sink(), model, method, args)
              }
            }
          )
        }
      }
    )

  const tx = clientOf(() => {
    const current = attempts.at(-1)
    if (!current || current.committed || current.rolledBack) {
      throw new Error('recordingTransaction: 事务客户端在事务之外被使用')
    }
    return current.statements
  })

  const $transaction = async (
    callback: (client: unknown) => unknown,
    options?: unknown
  ) => {
    const attempt: RecordedAttempt = {
      committed: false,
      rolledBack: false,
      options,
      statements: []
    }
    attempts.push(attempt)
    try {
      const result = await callback(tx)
      attempt.committed = true
      return result
    } catch (error) {
      attempt.rolledBack = true
      throw error
    }
  }

  const outsideClient = clientOf(() => outside)
  const prisma = new Proxy(
    {},
    {
      get(_target, key) {
        return key === '$transaction'
          ? $transaction
          : Reflect.get(outsideClient, key)
      }
    }
  )

  return {
    // 直接作为 vi.mock('~/prisma/index') 的工厂返回值
    module: { prisma, isPrismaTransactionConflict },
    attempts,
    outside,
    // 配置某个模型方法的返回值; 传函数时按入参计算
    on(label: string, result: unknown) {
      handlers.set(
        label,
        typeof result === 'function' ? (result as Handler) : () => result
      )
    },
    // 配置原生 SQL 的返回值, 按展平后的 SQL 文本匹配; 后登记的优先, 与 on 的覆盖一致
    onRaw(pattern: RegExp, result: unknown) {
      rawHandlers.unshift({
        pattern,
        handler:
          typeof result === 'function' ? (result as RawHandler) : () => result
      })
    },
    // 最近一次尝试的语句标签序列
    labels: () => (attempts.at(-1)?.statements ?? []).map((item) => item.label),
    // 最近一次尝试里某个标签的全部入参
    argsOf: (label: string) =>
      (attempts.at(-1)?.statements ?? [])
        .filter((item) => item.label === label)
        .map((item) => item.args),
    reset() {
      attempts.length = 0
      outside.length = 0
      handlers.clear()
      rawHandlers.length = 0
    }
  }
}

export type RecordingTransaction = ReturnType<typeof recordingTransaction>
