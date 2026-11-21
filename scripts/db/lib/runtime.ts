/* eslint-disable no-console */
import { execFileSync } from 'child_process'
import { readdirSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import { KUN_DERIVED_COLUMN_CHECKS } from './derivedColumns'
import {
  kunDiffObjects,
  kunFilterPrismaDiff,
  kunParseSnapshot,
  kunRenderSnapshot
} from './drift'
import {
  kunNotxCreatedIndexName,
  kunParseMigrationFile,
  kunPlanMigrations,
  kunSplitSqlStatements
} from './migrationFiles'
import type { KunDbObject } from './drift'
import type {
  KunLedgerRow,
  KunMigrationFile,
  KunMigrationPhase
} from './migrationFiles'

// 迁移工具的连库部分。只依赖 pg 与 Prisma CLI: 不 import ~/prisma (连接池退出要等
// 30s 空闲超时) 与 ~/lib/redis (esno 脚本碰到它会挂住)

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..'
)
export const KUN_MIGRATIONS_DIR = path.join(repoRoot, 'db/migrations')
export const KUN_SNAPSHOT_PATH = path.join(repoRoot, 'db/objects.snapshot.sql')
const PRISMA_DIFF_ALLOWLIST_PATH = path.join(
  repoRoot,
  'db/prisma-diff-allowlist.sql'
)

// 应用侧的事务级通告锁占用 481001~481005 五个域 (补丁类型 / 评分统计 / 收藏 / 点赞 /
// 群发邮件任务),
// 迁移执行器独占 (481010, 0), 同一个库上同时只跑一个执行器
const MIGRATION_LOCK_NAMESPACE = 481010
// 拿不到锁 (lock_timeout) 与死锁: 事务已整体回滚, 整个文件重试是安全的
const RETRYABLE_CODES = ['55P03', '40P01']
const MAX_ATTEMPTS = 3
const INSUFFICIENT_PRIVILEGE = '42501'
const SCRATCH_MARK = 'kun-scratch'

// 台账放在独立 schema: Prisma 只内省 public, db push 与 migrate diff 都不会碰它
// (7.10.1 实测), 生成的 client 里也不会多出一个 delegate
const LEDGER_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS kun_meta.schema_migration (
  version text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('sql', 'script')),
  phase text NOT NULL CHECK (phase IN ('pre', 'post')),
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  execution_ms integer NOT NULL,
  applied_by text NOT NULL DEFAULT current_user,
  baseline boolean NOT NULL DEFAULT false,
  note text
)`

export interface KunLedgerRecord extends KunLedgerRow {
  phase: KunMigrationPhase
  applied_at: Date
  execution_ms: number
  applied_by: string
  note: string | null
}

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export const kunRunCli = (main: () => Promise<void>) => {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`\n✗ ${describeError(error)}`)
      // RAISE EXCEPTION 的处置办法写在 HINT 里, 不能只打印 message
      for (const field of ['code', 'detail', 'hint', 'where'] as const) {
        if (error?.[field]) {
          console.error(`  ${field}: ${error[field]}`)
        }
      }
      process.exit(1)
    })
}

// 目录里不合命名约定的条目一律报错 (由解析器拒绝): 0008_x.SQL、0008_x.sql.txt
// 这类笔误若被跳过, 这个迁移就永远不会执行
export const kunLoadMigrationFiles = (): KunMigrationFile[] =>
  readdirSync(KUN_MIGRATIONS_DIR)
    .filter((fileName) => !fileName.startsWith('.'))
    .sort()
    .map((fileName) => {
      const parsed = kunParseMigrationFile(
        fileName,
        readFileSync(path.join(KUN_MIGRATIONS_DIR, fileName), 'utf8')
      )
      if (typeof parsed === 'string') {
        throw new Error(parsed)
      }
      return parsed
    })

// readOnly: 盘点与校验用。会话默认只读, 任何写入都会被库拒绝, 不靠代码自觉
export const kunConnect = async (
  connectionString: string | undefined,
  envName: string,
  { readOnly = false } = {}
) => {
  if (!connectionString) {
    throw new Error(`未设置环境变量 ${envName}`)
  }
  const client = new pg.Client({ connectionString })
  // 没有监听时, 连接被库端掐断会以 Unhandled 'error' event 崩溃, 看不到原因
  client.on('error', (error) => {
    console.error(`\n✗ 数据库连接中断: ${error.message}`)
    process.exit(1)
  })
  // 「already exists, skipping」之类的提示说明某条语句其实没有生效
  client.on('notice', (notice) => {
    console.log(`  ${notice.severity}: ${notice.message}`)
  })
  await client.connect()
  if (readOnly) {
    await client.query('SET default_transaction_read_only = on')
  }
  return client
}

export const kunReadLedger = async (
  client: pg.Client
): Promise<KunLedgerRecord[]> => {
  const exists = await client.query(
    "SELECT to_regclass('kun_meta.schema_migration') IS NOT NULL AS present"
  )
  if (!exists.rows[0].present) {
    return []
  }
  const { rows } = await client.query(
    'SELECT * FROM kun_meta.schema_migration ORDER BY version'
  )
  return rows
}

// 库里已有表而基线迁移不在台账里: 这个库不是由迁移建起来的 (db push 建的, 或恢复的备份
// 没带 kun_meta)。照常执行会从基线开始重建全部表, 撞上「已存在」而失败, 不如直接说清该做什么
export const kunRefuseUnregisteredDatabase = async (
  client: pg.Client,
  files: KunMigrationFile[]
) => {
  const baseline = files.map((file) => file.version).sort()[0]
  const ledger = await kunReadLedger(client)
  if (ledger.some((row) => row.kind === 'sql' && row.version === baseline)) {
    return
  }
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS tables
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`
  )
  if (rows[0].tables > 0) {
    throw new Error(
      `这个库的 public 下已有 ${rows[0].tables} 张表, 但基线迁移 ${baseline} 不在台账里: 它不是由 db:migrate 建起来的, 不能从头执行迁移。先跑 pnpm db:inspect --counts 盘点, 再用 pnpm db:migrate --mark-applied <版本> --reason <依据> 把库里已经具备的版本登记进台账 (见 AGENTS.md)`
    )
  }
}

// 会话级通告锁, 不显式释放: 各命令都是跑完即断开连接, 锁随会话结束。
// 拿不到就立刻失败而不排队: 排队的会话带着快照, 会让持锁一方的并发建索引死锁
export const kunPrepareLedger = async (client: pg.Client) => {
  const lock = await client.query(
    'SELECT pg_try_advisory_lock($1::int, 0) AS locked',
    [MIGRATION_LOCK_NAMESPACE]
  )
  if (!lock.rows[0].locked) {
    const holder = await client.query(
      `SELECT pid FROM pg_locks
       WHERE locktype = 'advisory' AND classid = $1 AND objid = 0 AND granted`,
      [MIGRATION_LOCK_NAMESPACE]
    )
    throw new Error(
      `另一个迁移执行器正在这个库上运行 (后端 pid ${holder.rows[0]?.pid ?? '未知'}), 等它结束后重跑`
    )
  }

  // CREATE SCHEMA IF NOT EXISTS 即使 schema 已存在也要先过库级 CREATE 权限检查,
  // 而应用用户往往不是库的属主, 所以先看存在与否
  const schema = await client.query(
    "SELECT to_regnamespace('kun_meta') IS NOT NULL AS present, current_user"
  )
  if (!schema.rows[0].present) {
    try {
      await client.query('CREATE SCHEMA kun_meta')
    } catch (error) {
      if ((error as { code?: string }).code !== INSUFFICIENT_PRIVILEGE) {
        throw error
      }
      throw new Error(
        `当前库用户没有建 schema 的权限。请用库的属主或超级用户执行一次: CREATE SCHEMA kun_meta AUTHORIZATION "${schema.rows[0].current_user}";`,
        { cause: error }
      )
    }
  }
  // 已存在就不再发 CREATE TABLE IF NOT EXISTS: 它每次都回一条「已存在, 跳过」的提示,
  // 会淹没真正需要看的那几条
  const table = await client.query(
    "SELECT to_regclass('kun_meta.schema_migration') IS NULL AS missing"
  )
  if (table.rows[0].missing) {
    await client.query(LEDGER_TABLE_DDL)
  }
}

export const kunInsertLedgerRow = async (
  client: pg.Client,
  file: KunMigrationFile,
  executionMs: number,
  baselineNote: string | null
) => {
  await client.query(
    `INSERT INTO kun_meta.schema_migration
       (version, kind, phase, checksum, execution_ms, baseline, note)
     VALUES ($1, 'sql', $2, $3, $4, $5, $6)`,
    [
      file.version,
      file.phase,
      file.checksum,
      executionMs,
      baselineNote !== null,
      baselineNote
    ]
  )
}

// 两个超时都显式设置: 不写指令时 statement_timeout 为 0 (不限), 不继承角色或库上的默认值
const setTimeouts = async (
  client: pg.Client,
  file: KunMigrationFile,
  scope: 'SET LOCAL' | 'SET'
) => {
  await client.query(`${scope} lock_timeout = ${file.lockTimeoutMs}`)
  await client.query(
    `${scope} statement_timeout = ${file.statementTimeoutMs ?? 0}`
  )
}

// 整个文件是一条查询消息, 报错位置是文件内的字符偏移, 换算成行号才好找
const attachLineNumber = (error: unknown, sql: string) => {
  const position = Number((error as { position?: string }).position)
  if (error instanceof Error && position > 0) {
    error.message += ` (第 ${sql.slice(0, position).split('\n').length} 行)`
  }
}

// 迁移与台账行同一个事务: 要么都生效, 要么都不生效
const applyTxMigration = async (client: pg.Client, file: KunMigrationFile) => {
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now()
    try {
      await client.query('BEGIN')
      await setTimeouts(client, file, 'SET LOCAL')
      await client.query(file.sql)
      await kunInsertLedgerRow(client, file, Date.now() - startedAt, null)
      await client.query('COMMIT')
      return
    } catch (error) {
      // 连接已断时 ROLLBACK 也会失败, 不能让它盖掉原始错误
      await client.query('ROLLBACK').catch(() => {})
      const code = (error as { code?: string }).code ?? ''
      if (!RETRYABLE_CODES.includes(code) || attempt >= MAX_ATTEMPTS) {
        attachLineNumber(error, file.sql)
        throw error
      }
      console.log(
        `  ${code === '40P01' ? '遇到死锁' : `${file.lockTimeoutMs}ms 内没拿到锁`}, 整个文件重试 (第 ${attempt + 1}/${MAX_ATTEMPTS} 次)`
      )
    }
  }
}

export const kunFindInvalidIndexes = async (
  client: pg.Client
): Promise<string[]> => {
  const { rows } = await client.query(`
    SELECT quote_ident(c.relname) AS name
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT i.indisvalid
    ORDER BY c.relname
  `)
  return rows.map((row) => row.name)
}

// 并发索引迁移被打断 (进程被杀、连接断开) 时, 目标索引以 INVALID 留在库里而台账没写。
// 执行器下次运行会先删掉它再重建, 所以这类残留不算故障; 来路不明的 INVALID 索引才算
export const kunFindPendingIndexLeftovers = async (
  client: pg.Client,
  pending: KunMigrationFile[]
): Promise<string[]> => {
  const targets = pending
    .filter((file) => file.mode === 'notx')
    .flatMap((file) => kunSplitSqlStatements(file.sql))
    .map(kunNotxCreatedIndexName)
    .filter((name) => name !== null)
  if (targets.length === 0) {
    return []
  }
  const { rows } = await client.query(
    `SELECT quote_ident(c.relname) AS name
     FROM unnest($1::text[]) AS target
     JOIN pg_index i ON i.indexrelid = to_regclass(target)
     JOIN pg_class c ON c.oid = i.indexrelid
     WHERE NOT i.indisvalid`,
    [targets]
  )
  return rows.map((row) => row.name)
}

const dropIndexIfInvalid = async (client: pg.Client, indexName: string) => {
  const { rows } = await client.query(
    'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)',
    [indexName]
  )
  if (rows.length === 0 || rows[0].indisvalid) {
    return false
  }
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${indexName}`)
  return true
}

// 并发索引语句失败会留下 INVALID 索引 (建索引留同名的, REINDEX 留 _ccnew / _ccold)。
// 执行前: 目标索引若是上次失败的 INVALID 残留就先删掉 —— IF NOT EXISTS 会把它当成
//   已存在而跳过, 台账却照写。
// 执行后: 这条语句新留下的 INVALID 索引一律删掉并报错退出。
// 全部成功才写台账; 中途失败整个文件重跑, 白名单内的语句均可重入
const applyNotxMigration = async (
  client: pg.Client,
  file: KunMigrationFile
) => {
  const startedAt = Date.now()
  await setTimeouts(client, file, 'SET')
  try {
    for (const statement of kunSplitSqlStatements(file.sql)) {
      const target = kunNotxCreatedIndexName(statement)
      if (target && (await dropIndexIfInvalid(client, target))) {
        console.log(`  已删除上次失败留下的 INVALID 索引 ${target}`)
      }
      const before = await kunFindInvalidIndexes(client)

      let failure: unknown
      try {
        await client.query(statement)
      } catch (error) {
        failure = error
      }

      const leftover = (await kunFindInvalidIndexes(client)).filter(
        (name) => !before.includes(name)
      )
      for (const name of leftover) {
        try {
          await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`)
        } catch (cleanupError) {
          // 清理失败不能盖掉建索引失败的原因; 残留由下一次运行的执行前检查清掉
          console.error(
            `  INVALID 索引 ${name} 没删掉 (${describeError(cleanupError)}), 下次运行会先清理`
          )
        }
      }
      if (failure) {
        throw failure
      }
      if (leftover.length > 0) {
        throw new Error(
          `语句执行后留下 INVALID 索引 ${leftover.join(', ')}, 已清理; 重跑本命令`
        )
      }
    }
  } finally {
    await client
      .query('RESET lock_timeout; RESET statement_timeout')
      .catch(() => {})
  }
  await kunInsertLedgerRow(client, file, Date.now() - startedAt, null)
}

export const kunRunMigrations = async (
  client: pg.Client,
  files: KunMigrationFile[],
  phase: KunMigrationPhase | 'all'
) => {
  await kunPrepareLedger(client)
  const plan = kunPlanMigrations(files, await kunReadLedger(client), phase)
  if (!plan.ok) {
    throw new Error(`${plan.reason}: ${plan.detail}`)
  }
  for (const file of plan.pending) {
    const startedAt = Date.now()
    console.log(`→ ${file.fileName} (${file.phase}, ${file.mode})`)
    await (file.mode === 'tx'
      ? applyTxMigration(client, file)
      : applyNotxMigration(client, file))
    console.log(`  完成, ${Date.now() - startedAt}ms`)
  }
  return plan.pending.length
}

// Prisma schema 看不见的库级对象。search_path 收到 pg_catalog, 让各环境导出的定义
// 一律带 schema 限定, 不随连接角色的 search_path 变化
export const kunExportObjects = async (
  client: pg.Client
): Promise<KunDbObject[]> => {
  await client.query('BEGIN READ ONLY')
  try {
    await client.query('SET LOCAL search_path = pg_catalog')
    const { rows } = await client.query(`
      SELECT 'function' AS kind,
             p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS name,
             pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prokind IN ('f', 'p')
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
        )
      UNION ALL
      SELECT 'trigger',
             c.relname || '.' || t.tgname,
             pg_get_triggerdef(t.oid)
               || CASE WHEN t.tgenabled = 'O' THEN '' ELSE ' /* tgenabled=' || t.tgenabled::text || ' */' END
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
      UNION ALL
      SELECT 'index', c.relname, pg_get_indexdef(i.indexrelid)
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND (i.indpred IS NOT NULL OR i.indexprs IS NOT NULL)
      UNION ALL
      SELECT 'check',
             c.relname || '.' || k.conname,
             format('ALTER TABLE %s ADD CONSTRAINT %I %s',
                    k.conrelid::regclass, k.conname, pg_get_constraintdef(k.oid))
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = k.connamespace
      WHERE n.nspname = 'public' AND k.contype = 'c'
      ORDER BY 1, 2
    `)
    return rows
  } finally {
    await client.query('ROLLBACK')
  }
}

// 输出「把该库变成 prisma/schema 所需的 SQL」。Prisma 7 的 migrate diff 只能从配置
// 文件取数据源, 所以对别的库做比对时覆盖子进程的 KUN_DATABASE_URL
export const kunPrismaDiff = (
  from: '--from-config-datasource' | '--from-empty',
  databaseUrl = process.env.KUN_DATABASE_URL
): string =>
  execFileSync(
    process.execPath,
    [
      createRequire(import.meta.url).resolve('prisma/build/index.js'),
      'migrate',
      'diff',
      from,
      '--to-schema',
      'prisma/schema',
      '--script'
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      env: {
        ...process.env,
        KUN_DATABASE_URL: databaseUrl,
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        CHECKPOINT_DISABLE: '1'
      }
    }
  )

// 现网的库级对象对照 db/objects.snapshot.sql, 返回不一致项 (缺失 / 定义不同 / 多余)。
// 先比整体文本: 逐对象解析只用来给出不一致的明细
export const kunCheckObjectDrift = (actual: KunDbObject[]): string[] => {
  const snapshot = readFileSync(KUN_SNAPSHOT_PATH, 'utf8').replace(
    /\r\n/g,
    '\n'
  )
  return kunRenderSnapshot(actual) === snapshot
    ? []
    : kunDiffObjects(kunParseSnapshot(snapshot), actual)
}

// 表、列与普通索引对照 prisma/schema: 扣掉白名单噪音后应当什么都不剩
export const kunCheckPrismaDrift = (databaseUrl?: string) => {
  const raw = kunPrismaDiff('--from-config-datasource', databaseUrl)
  return {
    raw,
    ...kunFilterPrismaDiff(
      raw,
      readFileSync(PRISMA_DIFF_ALLOWLIST_PATH, 'utf8')
    )
  }
}

// 逐项执行: 某一列在这个环境还不存在时, 只让这一项失败, 其余照常给出数字
export const kunCountDerivedMismatches = async (client: pg.Client) => {
  const results: {
    column: string
    mismatched: number | null
    error?: string
  }[] = []
  for (const check of KUN_DERIVED_COLUMN_CHECKS) {
    try {
      const { rows } = await client.query(check.sql)
      results.push({ column: check.column, mismatched: rows[0].mismatched })
    } catch (error) {
      results.push({
        column: check.column,
        mismatched: null,
        error: describeError(error)
      })
    }
  }
  return results
}

const databaseIdentity = async (client: pg.Client) => {
  const { rows } = await client.query(`
    SELECT current_database() || '/' || d.oid || '/' || pg_postmaster_start_time() AS identity
    FROM pg_database d WHERE d.datname = current_database()
  `)
  return rows[0].identity as string
}

// 回放库会被 DROP SCHEMA public CASCADE 整个清空, 所以只认两种库:
// 1. 没打过标记: 全库 (系统 schema 之外) 没有任何表或视图;
// 2. 打过标记 (上一次由本工具清空并回放): public 与 kun_meta 之外没有任何表或视图,
//    且 public 下每张表都没有行 —— 回放只建结构, 有行说明它后来被当成真库用过。
// 另按库身份 (不是 URL 字面) 拒绝与 KUN_DATABASE_URL 相同的库
const assertScratchDatabase = async (client: pg.Client) => {
  const refuse = (reason: string) => {
    throw new Error(`KUN_DB_SCRATCH_URL 指向的库${reason}, 拒绝清空`)
  }

  if (process.env.KUN_DATABASE_URL) {
    const main = new pg.Client({
      connectionString: process.env.KUN_DATABASE_URL
    })
    // 主库连不上时无从比较, 由下面的结构与行数检查把关
    const mainIdentity = await main
      .connect()
      .then(() => databaseIdentity(main))
      .catch(() => null)
      .finally(() => main.end().catch(() => {}))
    if (mainIdentity === (await databaseIdentity(client))) {
      refuse('与 KUN_DATABASE_URL 是同一个库')
    }
  }

  const { rows } = await client.query(`
    SELECT
      COALESCE((SELECT obj_description(oid, 'pg_namespace') = '${SCRATCH_MARK}'
                FROM pg_namespace WHERE nspname = 'kun_meta'), false) AS marked,
      ARRAY(
        SELECT format('%I.%I', n.nspname, c.relname)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        ORDER BY 1
      ) AS relations
  `)
  const { marked, relations } = rows[0] as {
    marked: boolean
    relations: string[]
  }

  if (!marked) {
    if (relations.length > 0) {
      refuse(`里有 ${relations.length} 张表或视图, 且不是本工具建出来的回放库`)
    }
    return
  }

  const foreign = relations.filter(
    (name) => !name.startsWith('public.') && !name.startsWith('kun_meta.')
  )
  if (foreign.length > 0) {
    refuse(`在 public 之外还有 ${foreign.join(', ')}`)
  }
  for (const name of relations.filter((name) => name.startsWith('public.'))) {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM ${name}) AS has_rows`
    )
    if (result.rows[0].has_rows) {
      refuse(`的 ${name} 里有数据, 它被当作真实的库用过`)
    }
  }
}

export const kunConnectScratch = async () => {
  const client = await kunConnect(
    process.env.KUN_DB_SCRATCH_URL,
    'KUN_DB_SCRATCH_URL (一个可以随时清空的回放库, 见 AGENTS.md)'
  )
  try {
    await assertScratchDatabase(client)
  } catch (error) {
    await client.end()
    throw error
  }
  return client
}

// 只能对 kunConnectScratch 返回的连接调用
export const kunResetScratch = async (client: pg.Client) => {
  await client.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS kun_meta CASCADE;
    CREATE SCHEMA public;
    CREATE SCHEMA kun_meta;
    COMMENT ON SCHEMA kun_meta IS '${SCRATCH_MARK}';
  `)
}

export const kunReplayIntoScratch = async (
  client: pg.Client,
  files: KunMigrationFile[]
) => {
  await kunResetScratch(client)
  await kunRunMigrations(client, files, 'all')
}
