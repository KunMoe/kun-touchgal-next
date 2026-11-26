import { vi } from 'vitest'
import { generateConfig, Hotp } from 'time2fa'
import { answerLowerLookup } from '~/server/identity/__tests__/support/lowerLookup'

// 凭证类路由 (改邮箱 / 改密码 / 2FA / 管理员关 2FA) 的边界假对象, 全部是内存状态:
// user / admin_log / user_email_change 三张表、KV、尝试预算、会话、邮件投递。断言看最终状态,
// 不看内部调用形状。
// 只实现被测路由用到的查询形状, 其余 (没实现的方法、复合 where、操作符对象) 一律抛错,
// 免得一条没实现的查询静默回空让用例照样通过。
//
// 用法 (vi.mock 的工厂在导入阶段执行, 实例须经 vi.hoisted 提前建好):
//   const fakes = await vi.hoisted(async () =>
//     (
//       await import('~/app/api/user/setting/__tests__/_credentialFakes')
//     ).createCredentialFakes()
//   )
//   vi.mock('~/prisma/index', () => fakes.modules.prisma)
//   vi.mock('~/lib/redis', () => fakes.modules.redis)
//   vi.mock('~/server/auth/attemptBudget', () => fakes.modules.budget)
//   vi.mock('~/middleware/_verifyHeaderCookie', () => fakes.modules.session)
//   vi.mock('~/server/auth/session', () => fakes.modules.sessionStore)
//   vi.mock('next/headers', () => fakes.modules.headers)
// 每个用例前调 fakes.reset(); 要发邮件的用例再调 fakes.mail.install() (vi.stubGlobal 的 fetch)

export interface FakeUserRow {
  id: number
  name: string
  email: string
  password: string
  role: number
  enable_2fa: boolean
  two_factor_secret: string
  two_factor_backup: string[]
  security_stamp: Date | null
}

export interface FakeEmailChangeRow {
  id: number
  user_id: number
  old_email: string
  new_email: string
  revert_token_hash: string
  created: Date
  expires: Date
  reverted: Date | null
}

export interface FakeAdminLogRow {
  id: number
  type: string
  user_id: number
  content: string
}

const USER_COLUMNS = new Set<string>([
  'id',
  'name',
  'email',
  'password',
  'role',
  'enable_2fa',
  'two_factor_secret',
  'two_factor_backup',
  'security_stamp'
])
const ADMIN_LOG_COLUMNS = new Set<string>(['type', 'user_id', 'content'])

const unsupported = (what: string, args?: unknown): never => {
  throw new Error(
    `credential fake: 未实现 ${what}${args === undefined ? '' : ` ${JSON.stringify(args)}`}`
  )
}

// 访问没实现的方法立即抛错 (symbol 与 then 放行, 否则 await / 打印会误触)
const strict = <T extends object>(name: string, target: T): T =>
  new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key === 'symbol' || key === 'then' || key in obj) {
        return Reflect.get(obj, key, receiver)
      }
      return unsupported(`${name}.${key}`)
    }
  })

const prismaError = (code: string, message: string) =>
  Object.assign(new Error(message), { code })

const isScalar = (value: unknown) =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

const checkColumns = (
  columns: Set<string>,
  what: string,
  record: Record<string, unknown>
) => {
  for (const [key, value] of Object.entries(record)) {
    const isStringArray =
      Array.isArray(value) && value.every((item) => typeof item === 'string')
    if (
      !columns.has(key) ||
      !(isScalar(value) || isStringArray || value instanceof Date)
    ) {
      unsupported(what, { [key]: value })
    }
  }
}

// 与 twoFactorBackupCode.ts 的 consumeTwoFactorBackupCode 同形的那一条原生 UPDATE;
// 其它原生 SQL 一律抛错
const BACKUP_CONSUME_SQL =
  'UPDATE "user" SET two_factor_backup = array_remove( array_remove(two_factor_backup, ?), ? ) WHERE id = ? AND enable_2fa = true AND ( ? = ANY(two_factor_backup) OR ? = ANY(two_factor_backup) )'

const createFakeDb = () => {
  let users = new Map<number, FakeUserRow>()
  let adminLogs: FakeAdminLogRow[] = []
  let emailChanges: FakeEmailChangeRow[] = []
  // 每次查询的标签 ('user.findUnique' 等), 用于「校验失败不碰库」一类断言
  const queries: string[] = []
  // 每次 $transaction 的结局, 按调用顺序
  const transactions: { committed: boolean }[] = []
  let nextWriteHook: (() => void) | null = null

  const runWriteHook = () => {
    const hook = nextWriteHook
    nextWriteHook = null
    hook?.()
  }

  const findByUniqueWhere = (where: Record<string, unknown>) => {
    const keys = Object.keys(where ?? {})
    if (keys.length === 1 && keys[0] === 'id' && typeof where.id === 'number') {
      return users.get(where.id)
    }
    if (
      keys.length === 1 &&
      keys[0] === 'email' &&
      typeof where.email === 'string'
    ) {
      return [...users.values()].find((user) => user.email === where.email)
    }
    return unsupported('user where', where)
  }

  const project = (row: FakeUserRow, select?: Record<string, unknown>) => {
    if (!select) {
      return structuredClone(row)
    }
    for (const [key, value] of Object.entries(select)) {
      if (!USER_COLUMNS.has(key) || value !== true) {
        unsupported('user select', { [key]: value })
      }
    }
    return Object.fromEntries(
      Object.keys(select).map((key) => [
        key,
        structuredClone(row[key as keyof FakeUserRow])
      ])
    )
  }

  // 时间列 (security_stamp) 按毫秒值比, 与库里 timestamp(3) 的相等一致
  const sameValue = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date
      ? a.getTime() === b.getTime()
      : a === b

  const matchesFlatWhere = (row: FakeUserRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      if (
        !USER_COLUMNS.has(key) ||
        !(isScalar(value) || value instanceof Date)
      ) {
        unsupported('user updateMany where', { [key]: value })
      }
      return sameValue(row[key as keyof FakeUserRow], value)
    })

  // 事务里每笔写记一条撤销动作; 事务外 (journal 为 null) 的写即刻生效、回滚不撤,
  // 与真实库一致: 在事务回调里误用全局 prisma 的写不会随事务回滚
  type Journal = (() => void)[] | null

  const setUser = (journal: Journal, next: FakeUserRow) => {
    const before = users.get(next.id)
    users.set(next.id, next)
    journal?.push(() => {
      if (before) {
        users.set(next.id, before)
      } else {
        users.delete(next.id)
      }
    })
  }

  // 写入一行; email / name 守唯一约束 (P2002)。库里每列除了大小写敏感的 @unique 还有
  // lower() 唯一索引 (迁移 0018), 所以只差大小写也算冲突
  const writeUser = (
    journal: Journal,
    row: FakeUserRow,
    data: Record<string, unknown>
  ) => {
    checkColumns(USER_COLUMNS, 'user data', data)
    const next = { ...row, ...structuredClone(data) } as FakeUserRow
    for (const column of ['email', 'name'] as const) {
      const taken = [...users.values()].some(
        (other) =>
          other.id !== row.id &&
          other[column].toLowerCase() === next[column].toLowerCase()
      )
      if (column in data && taken) {
        throw prismaError(
          'P2002',
          `Unique constraint failed on the fields: (\`${column}\`)`
        )
      }
    }
    setUser(journal, next)
  }

  const delegates = (journal: Journal) => ({
    user: strict('prisma.user', {
      findUnique: async (args: {
        where: Record<string, unknown>
        select?: Record<string, unknown>
      }) => {
        queries.push('user.findUnique')
        const row = findByUniqueWhere(args.where)
        return row ? project(row, args.select) : null
      },
      update: async (args: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        queries.push('user.update')
        const keys = Object.keys(args.where ?? {})
        if (keys.length !== 1 || typeof args.where.id !== 'number') {
          unsupported('user.update where', args.where)
        }
        runWriteHook()
        const row = users.get(args.where.id as number)
        if (!row) {
          throw prismaError('P2025', 'Record to update not found.')
        }
        writeUser(journal, row, args.data)
        return structuredClone(users.get(row.id))
      },
      updateMany: async (args: {
        where: Record<string, unknown>
        data: Record<string, unknown>
      }) => {
        queries.push('user.updateMany')
        runWriteHook()
        const matched = [...users.values()].filter((row) =>
          matchesFlatWhere(row, args.where)
        )
        for (const row of matched) {
          writeUser(journal, row, args.data)
        }
        return { count: matched.length }
      }
    }),
    admin_log: strict('prisma.admin_log', {
      create: async (args: { data: Record<string, unknown> }) => {
        queries.push('admin_log.create')
        checkColumns(ADMIN_LOG_COLUMNS, 'admin_log data', args.data)
        runWriteHook()
        const row = {
          id: adminLogs.length + 1,
          ...args.data
        } as FakeAdminLogRow
        adminLogs.push(row)
        journal?.push(() => {
          adminLogs = adminLogs.filter((logged) => logged !== row)
        })
        return structuredClone(row)
      }
    }),
    // 只实现 server/auth/emailChange.ts 用到的四种形状
    user_email_change: strict('prisma.user_email_change', {
      findFirst: async (args: {
        where: Record<string, unknown>
        select?: Record<string, unknown>
        orderBy?: Record<string, unknown>
      }) => {
        queries.push('user_email_change.findFirst')
        const { user_id, created, old_email, reverted, ...rest } = args.where
        if (typeof user_id !== 'number' || Object.keys(rest).length) {
          return unsupported('user_email_change.findFirst where', args.where)
        }

        // 冷却: { user_id, created: { gt } }
        if (created !== undefined) {
          const after = (created as { gt?: unknown }).gt
          if (
            !(after instanceof Date) ||
            Object.keys(created as object).length !== 1 ||
            old_email !== undefined ||
            reverted !== undefined ||
            args.orderBy
          ) {
            return unsupported('user_email_change.findFirst where', args.where)
          }
          const row = emailChanges.find(
            (change) => change.user_id === user_id && change.created > after
          )
          return row ? structuredClone(row) : null
        }

        // 旧链接顺着后一跳撤回: { user_id, old_email, reverted: null }, 取最新的一行
        if (
          typeof old_email !== 'string' ||
          reverted !== null ||
          JSON.stringify(args.orderBy) !== '{"id":"desc"}'
        ) {
          return unsupported('user_email_change.findFirst where', args.where)
        }
        const row = emailChanges
          .filter(
            (change) =>
              change.user_id === user_id &&
              change.old_email === old_email &&
              change.reverted === null
          )
          .sort((a, b) => b.id - a.id)[0]
        return row ? structuredClone(row) : null
      },
      findUnique: async (args: { where: { revert_token_hash: string } }) => {
        queries.push('user_email_change.findUnique')
        const keys = Object.keys(args.where ?? {})
        if (keys.length !== 1 || keys[0] !== 'revert_token_hash') {
          return unsupported('user_email_change.findUnique where', args.where)
        }
        const row = emailChanges.find(
          (change) => change.revert_token_hash === args.where.revert_token_hash
        )
        return row ? structuredClone(row) : null
      },
      create: async (args: {
        data: Omit<FakeEmailChangeRow, 'id' | 'reverted'>
      }) => {
        queries.push('user_email_change.create')
        runWriteHook()
        const { data } = args
        // created 没有库默认值, 三个时间列都必须由应用给出
        if (
          !(data.created instanceof Date) ||
          !(data.expires instanceof Date)
        ) {
          return unsupported('user_email_change.create data', data)
        }
        if (
          emailChanges.some(
            (change) => change.revert_token_hash === data.revert_token_hash
          )
        ) {
          throw prismaError(
            'P2002',
            'Unique constraint failed on the fields: (`revert_token_hash`)'
          )
        }
        const row: FakeEmailChangeRow = {
          ...structuredClone(data),
          id: Math.max(0, ...emailChanges.map((change) => change.id)) + 1,
          reverted: null
        }
        emailChanges.push(row)
        journal?.push(() => {
          emailChanges = emailChanges.filter((change) => change !== row)
        })
        return structuredClone(row)
      },
      updateMany: async (args: {
        where: { id: number; reverted: null }
        data: { reverted: Date }
      }) => {
        queries.push('user_email_change.updateMany')
        const whereKeys = Object.keys(args.where ?? {}).sort()
        const dataKeys = Object.keys(args.data ?? {})
        if (
          whereKeys.join() !== 'id,reverted' ||
          args.where.reverted !== null ||
          dataKeys.join() !== 'reverted' ||
          !(args.data.reverted instanceof Date)
        ) {
          return unsupported('user_email_change.updateMany', args)
        }
        runWriteHook()
        const row = emailChanges.find(
          (change) => change.id === args.where.id && change.reverted === null
        )
        if (!row) {
          return { count: 0 }
        }
        row.reverted = args.data.reverted
        journal?.push(() => {
          row.reverted = null
        })
        return { count: 1 }
      }
    }),
    // 只认 server/identity/lookup.ts 按 lower() 找人 / 查重的那一条, 其它原生查询抛错
    $queryRaw: async (query: unknown) => {
      queries.push('$queryRaw')
      return answerLowerLookup(users.values(), query)
    },
    $executeRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim()
      queries.push('$executeRaw')
      if (sql !== BACKUP_CONSUME_SQL) {
        return unsupported('$executeRaw', sql)
      }
      runWriteHook()
      const [token, hashedToken, uid] = values as [string, string, number]
      const row = users.get(uid)
      const matches = (code: string) => code === token || code === hashedToken
      if (!row || !row.enable_2fa || !row.two_factor_backup.some(matches)) {
        return 0
      }
      setUser(journal, {
        ...row,
        two_factor_backup: row.two_factor_backup.filter(
          (code) => !matches(code)
        )
      })
      return 1
    }
  })

  // 只支持回调式事务: 抛错即按撤销记录倒序回滚本事务的写
  const $transaction = async (callback: unknown) => {
    if (typeof callback !== 'function') {
      return unsupported('$transaction(非回调)')
    }
    const journal: (() => void)[] = []
    try {
      const result = await callback(strict('prisma(tx)', delegates(journal)))
      transactions.push({ committed: true })
      return result
    } catch (error) {
      for (const undo of journal.reverse()) {
        undo()
      }
      transactions.push({ committed: false })
      throw error
    }
  }

  return {
    client: strict('prisma', { ...delegates(null), $transaction }),
    queries,
    transactions,
    insertUser: (row: FakeUserRow) => {
      users.set(row.id, structuredClone(row))
    },
    // 当前行的副本; 不存在为 undefined
    user: (id: number) => structuredClone(users.get(id)),
    // 直接改库 (模拟并发的另一个请求), 不记入 queries
    patchUser: (id: number, data: Partial<FakeUserRow>) => {
      const row = users.get(id)
      if (!row) {
        throw new Error(`credential fake: 没有用户 ${id}`)
      }
      users.set(id, { ...row, ...structuredClone(data) })
    },
    adminLogs: () => structuredClone(adminLogs),
    emailChanges: () => structuredClone(emailChanges),
    insertEmailChange: (row: Omit<FakeEmailChangeRow, 'id'>) => {
      emailChanges.push({
        ...structuredClone(row),
        id: Math.max(0, ...emailChanges.map((change) => change.id)) + 1
      })
    },
    // 下一次写 (update / updateMany / create / $executeRaw) 真正落库前先跑 hook;
    // hook 抛错即该次写失败
    interceptNextWrite: (hook: () => void) => {
      nextWriteHook = hook
    },
    failNextWrite: (
      error: unknown = prismaError('P2002', 'Unique constraint failed')
    ) => {
      nextWriteHook = () => {
        throw error
      }
    },
    reset: () => {
      users = new Map()
      adminLogs = []
      emailChanges = []
      queries.length = 0
      transactions.length = 0
      nextWriteHook = null
    }
  }
}

const createFakeKv = () => {
  // ttl 为 setKv 的第三个参数 (秒); 没传为 null
  const entries = new Map<string, { value: string; ttl: number | null }>()
  const kvModule = {
    getKv: async (key: string) => entries.get(key)?.value ?? null,
    setKv: async (key: string, value: string, time?: number) => {
      entries.set(key, { value, ttl: time || null })
    },
    delKv: async (key: string) => {
      entries.delete(key)
    },
    takeKv: async (key: string) => entries.delete(key),
    setKvIfAbsent: async (key: string, value: string, time: number) => {
      if (entries.has(key)) {
        return false
      }
      entries.set(key, { value, ttl: time })
      return true
    }
  }
  return {
    module: kvModule,
    entries,
    get: (key: string) => entries.get(key) ?? null,
    keys: () => [...entries.keys()],
    put: (key: string, value: string, ttl: number | null = null) => {
      entries.set(key, { value, ttl })
    }
  }
}

// server/auth/attemptBudget 的内存替身。计数规则照脚本: 任一维度用完即整体拒绝且一个都不加,
// 结算清掉各维度的计数。窗口不模拟; 脚本本身由 *.redis.test.ts 在真 Redis 上守护
const createFakeBudget = () => {
  type Dim = { key: string; limit: number }
  const counts = new Map<string, number>()
  let nextError: Error | null = null

  const throwIfBroken = () => {
    const error = nextError
    nextError = null
    if (error) {
      throw error
    }
  }

  return {
    counts,
    // 下一次预留或结算抛错, 模拟 Redis 不可用
    failNext: (error = new Error('redis unavailable')) => {
      nextError = error
    },
    module: {
      reserveAttempt: async (dims: Dim[]) => {
        throwIfBroken()
        const exhausted = dims.find(
          (dim) => (counts.get(dim.key) ?? 0) >= dim.limit
        )
        if (exhausted) {
          return {
            allowed: false,
            reason: 'exhausted',
            dimension: exhausted.key
          }
        }
        return {
          allowed: true,
          remaining: dims.map((dim) => {
            const count = (counts.get(dim.key) ?? 0) + 1
            counts.set(dim.key, count)
            return dim.limit - count
          })
        }
      },
      settleSuccess: async (dims: Dim[]) => {
        throwIfBroken()
        for (const dim of dims) {
          counts.delete(dim.key)
        }
        return true
      }
    },
    reset: () => {
      counts.clear()
      nextError = null
    }
  }
}

export interface FakeSessionPayload {
  iss: string
  aud: string
  jti: string
  uid: number
  name: string
  role: number
  // 令牌带的安全戳 (毫秒); 重签之后换成新戳
  cs?: number
}

const createFakeSession = () => {
  let current: FakeSessionPayload | null = null
  const revokedUids: number[] = []
  // deleteOtherKunTokenSessions 的调用: 吊销这个账号除 keptJti 之外的会话
  const revokedOthers: { uid: number; keptJti: string }[] = []
  // reissueKunSessionToken 的调用: 当前会话换上新戳重签
  const reissued: { uid: number; jti: string; stamp: Date }[] = []
  const deletedCookies: string[] = []
  const setCookies: unknown[][] = []
  // 吊销会话时的回调, 用于在吊销那一刻观察库里的状态
  let onRevoke: ((uid: number) => void) | null = null

  return {
    revokedUids,
    revokedOthers,
    reissued,
    deletedCookies,
    setCookies,
    signIn: (uid: number, role: number, name = `user-${uid}`) => {
      current = { iss: 'test', aud: 'test', jti: `jti-${uid}`, uid, name, role }
    },
    signOut: () => {
      current = null
    },
    onRevoke: (hook: (uid: number) => void) => {
      onRevoke = hook
    },
    sessionModule: {
      verifyHeaderCookie: async () => current
    },
    // server/auth/session 里 securityEvents 用到的三个会话存储函数
    sessionStoreModule: {
      deleteKunToken: async (uid: number) => {
        revokedUids.push(uid)
        onRevoke?.(uid)
      },
      deleteOtherKunTokenSessions: async (uid: number, keptJti: string) => {
        revokedOthers.push({ uid, keptJti })
        return 0
      },
      reissueKunSessionToken: async (
        payload: { uid: number; jti: string },
        stamp: Date
      ) => {
        reissued.push({ uid: payload.uid, jti: payload.jti, stamp })
        // 浏览器拿到重签后的 cookie: 之后的请求带新戳
        if (current?.jti === payload.jti) {
          current = { ...current, cs: stamp.getTime() }
        }
        return true
      }
    },
    headersModule: {
      cookies: async () => ({
        delete: (name: string) => {
          deletedCookies.push(name)
        },
        set: (...args: unknown[]) => {
          setCookies.push(args)
        }
      })
    },
    reset: () => {
      current = null
      revokedUids.length = 0
      revokedOthers.length = 0
      reissued.length = 0
      deletedCookies.length = 0
      setCookies.length = 0
      onRevoke = null
    }
  }
}

export const FAKE_MAIL_HOST = 'https://mail.test'
export const FAKE_SITE_ADDRESS = 'https://site.test'

export interface FakeMail {
  to: string[]
  subject: string
  html: string
  plain: string
  // 请求带的 AbortSignal: 有没有给发信设上限
  signal: AbortSignal | null
}

// 'ok' 正常投递; 'http-error' 非 2xx; 'status-error' 2xx 但 { status: 'error' }; 'throw' 网络异常
export type FakeMailMode = 'ok' | 'http-error' | 'status-error' | 'throw'

const createFakeMail = () => {
  // 每一次投递尝试 (含失败的), 按顺序
  const outbox: FakeMail[] = []
  let mode: FakeMailMode = 'ok'
  // 投递那一刻的回调, 用于观察「先通知、后写库」一类顺序
  let onSend: (() => void) | null = null

  const fetchFake = async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith(`${FAKE_MAIL_HOST}/`)) {
      throw new Error(`credential fake: 意外的外部请求 ${url}`)
    }
    const body = JSON.parse(String(init?.body))
    outbox.push({
      to: body.to,
      subject: body.subject,
      html: body.html_body,
      plain: body.plain_body,
      signal: init?.signal ?? null
    })
    onSend?.()
    switch (mode) {
      case 'throw':
        throw new TypeError('fetch failed')
      case 'http-error':
        return new Response('bad gateway', { status: 502 })
      case 'status-error':
        return Response.json({ status: 'error' })
      default:
        return Response.json({ status: 'success' })
    }
  }

  return {
    outbox,
    setMode: (next: FakeMailMode) => {
      mode = next
    },
    onSend: (hook: () => void) => {
      onSend = hook
    },
    install: () => {
      vi.stubEnv('KUN_VISUAL_NOVEL_EMAIL_HOST', FAKE_MAIL_HOST)
      vi.stubEnv('NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD', FAKE_SITE_ADDRESS)
      vi.stubGlobal('fetch', fetchFake)
    },
    reset: () => {
      outbox.length = 0
      mode = 'ok'
      onSend = null
    }
  }
}

export const createCredentialFakes = () => {
  const db = createFakeDb()
  const kv = createFakeKv()
  const budget = createFakeBudget()
  const session = createFakeSession()
  const mail = createFakeMail()

  return {
    db,
    kv,
    budget,
    session,
    mail,
    modules: {
      prisma: { prisma: db.client },
      redis: kv.module,
      budget: budget.module,
      session: session.sessionModule,
      sessionStore: session.sessionStoreModule,
      headers: session.headersModule
    },
    reset: () => {
      db.reset()
      kv.entries.clear()
      budget.reset()
      session.reset()
      mail.reset()
    }
  }
}

export const makeUser = (
  overrides: Partial<FakeUserRow> = {}
): FakeUserRow => ({
  id: 7,
  name: 'kun',
  email: 'old@example.com',
  password: '',
  role: 1,
  enable_2fa: false,
  two_factor_secret: '',
  two_factor_backup: [],
  security_stamp: null,
  ...overrides
})

// 一个时间步 (30 秒) 开头后 10 秒: 「当前步」「上一步」都确定
export const FIXED_NOW = new Date('2027-01-15T08:00:10.000Z')

// 16 位 base32 = 10 字节, 与 Totp.generateKey 生成的密钥同长
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXP'

// 当前系统时间所在步 (+offset) 的 TOTP 码
export const totpAt = (secret: string, stepOffset = 0) =>
  Hotp.generatePasscode(
    {
      secret,
      counter: Math.floor(Date.now() / 1000 / 30) + stepOffset
    },
    generateConfig()
  )

// 与前一步 / 当前步 / 后一步都不同的 6 位码
export const wrongTotp = (secret: string) => {
  const nearby = new Set([-1, 0, 1].map((offset) => totpAt(secret, offset)))
  for (let i = 0; ; i++) {
    const code = String(i).padStart(6, '0')
    if (!nearby.has(code)) {
      return code
    }
  }
}

export const jsonRequest = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
