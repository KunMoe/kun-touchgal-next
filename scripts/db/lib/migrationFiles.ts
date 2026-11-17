import { createHash } from 'crypto'

// db/migrations 下迁移文件的解析与执行计划。纯函数, 不连库, 由 vitest 直接覆盖。
// 约定:
//   NNNN_slug.sql       整文件一个事务
//   NNNN_slug.notx.sql  不进事务, 只允许并发索引语句
// 文件头 (首条 SQL 之前的注释行) 可写指令:
//   -- phase: pre|post          默认 pre; post 在新代码上线之后执行
//   -- lock_timeout: 5s         tx 文件默认 5s, notx 文件默认不限
//   -- statement_timeout: 10min 默认不限

export type KunMigrationPhase = 'pre' | 'post'
export type KunMigrationMode = 'tx' | 'notx'

export interface KunMigrationFile {
  version: string
  slug: string
  fileName: string
  phase: KunMigrationPhase
  mode: KunMigrationMode
  lockTimeoutMs: number
  statementTimeoutMs: number | null
  sql: string
  checksum: string
}

export interface KunLedgerRow {
  version: string
  // 'sql' 对应 db/migrations 下的文件; 'script' 留给一次性脚本运行时, 计划时忽略
  kind: string
  checksum: string
  // 经 --mark-applied 登记的既有状态, 不是在本库按序执行出来的
  baseline: boolean
}

export type KunMigrationPlanFailure =
  | 'checksum-mismatch'
  | 'applied-file-missing'
  | 'pending-post-before-pre'
  | 'pending-pre-before-post'
  | 'out-of-order'
  | 'duplicate-version'

export type KunMigrationPlan =
  | { ok: true; pending: KunMigrationFile[] }
  | { ok: false; reason: KunMigrationPlanFailure; detail: string }

// tx 文件等锁时, 排在它后面的业务请求也被挡住, 所以等不到就放弃重试。
// notx 文件的并发索引语句排队时不挡读写, 而它等待在途事务也受 lock_timeout 约束:
// 设了上限的话, 库里任何一条跑得久一点的语句都会让它失败, 所以默认不限
const DEFAULT_LOCK_TIMEOUT_MS = { tx: 5000, notx: 0 }

const FILE_NAME_PATTERN = /^(\d{4})_([a-z0-9_]+)(\.notx)?\.sql$/
const DIRECTIVE_PATTERN =
  /^--\s*(phase|lock_timeout|statement_timeout)\s*:\s*(.*)$/
// 大小写、连字符、全角冒号等近似写法: 看着像指令却不会被当成指令
const DIRECTIVE_LIKE_PATTERN =
  /^--\s*(phase|lock[_-]?timeout|statement[_-]?timeout)\s*[:：]/i
// 其余「小写单词 + 冒号」开头的注释行多半是拼错的指令名; 放过 https:// 这样的网址
const UNKNOWN_DIRECTIVE_PATTERN = /^--\s*([a-z_]+)\s*[:：](?!\/\/)/
const TX_CONTROL_PATTERN =
  /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/i
const NOTX_ALLOWED_PATTERNS = [
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s/i,
  /^DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s/i,
  /^REINDEX\s+INDEX\s+CONCURRENTLY\s/i,
  /^ANALYZE\b/i
]
const NOTX_CREATED_INDEX_PATTERN =
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/i
const DOLLAR_TAG_PATTERN = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/
const IDENTIFIER_CHAR_PATTERN = /[A-Za-z0-9_$]/

const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, min: 60000 }

const parseDuration = (value: string): number | null => {
  const match = /^(\d+)(ms|s|min)$/.exec(value)
  return match ? Number(match[1]) * DURATION_UNIT_MS[match[2]] : null
}

// 把 SQL 切成顶层语句: 去掉注释, 只在引号与美元引用之外的分号处切分。
// 不识别 BEGIN ATOMIC 函数体; 迁移里的函数体一律用 $$
export const kunSplitSqlStatements = (sql: string): string[] => {
  const statements: string[] = []
  let current = ''
  let i = 0

  const flush = () => {
    const statement = current.trim()
    if (statement) {
      statements.push(statement)
    }
    current = ''
  }
  // 原样带走 [i, 闭合符之后) 这一段; 找不到闭合符就带走到结尾
  const takeUntil = (closer: string, from: number) => {
    const end = sql.indexOf(closer, from)
    const stop = end === -1 ? sql.length : end + closer.length
    current += sql.slice(i, stop)
    i = stop
  }

  while (i < sql.length) {
    const ch = sql[i]
    const next = sql[i + 1]

    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      continue
    }
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      current += ' '
      continue
    }
    // E'..' 串里反斜杠转义引号: E'\'' 不在第二个引号处结束
    if (
      ch === "'" &&
      /[Ee]/.test(sql[i - 1] ?? '') &&
      !IDENTIFIER_CHAR_PATTERN.test(sql[i - 2] ?? '')
    ) {
      let end = i + 1
      while (end < sql.length) {
        if (sql[end] === '\\' || (sql[end] === "'" && sql[end + 1] === "'")) {
          end += 2
        } else if (sql[end] === "'") {
          break
        } else {
          end++
        }
      }
      current += sql.slice(i, end + 1)
      i = end + 1
      continue
    }
    // '' 与 "" 转义等价于「闭合后立刻重开」, 对切分没有影响
    if (ch === "'" || ch === '"') {
      takeUntil(ch, i + 1)
      continue
    }
    if (ch === '$' && !IDENTIFIER_CHAR_PATTERN.test(sql[i - 1] ?? '')) {
      const tag = DOLLAR_TAG_PATTERN.exec(sql.slice(i, i + 66))
      if (tag) {
        takeUntil(tag[0], i + tag[0].length)
        continue
      }
    }
    if (ch === ';') {
      flush()
      i++
      continue
    }
    current += ch
    i++
  }
  flush()

  return statements
}

// notx 文件逐条执行、不进事务, 所以只放可重入的并发索引语句
export const kunSplitNotxStatements = (sql: string): string[] | string => {
  const statements = kunSplitSqlStatements(sql)
  for (const statement of statements) {
    if (!NOTX_ALLOWED_PATTERNS.some((pattern) => pattern.test(statement))) {
      return `notx 文件只允许 CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS / DROP INDEX CONCURRENTLY IF EXISTS / REINDEX INDEX CONCURRENTLY / ANALYZE, 出现了: ${statement.slice(0, 80)}`
    }
  }
  return statements
}

// CREATE INDEX CONCURRENTLY 失败会留下同名 INVALID 索引, 执行器据此名字复查
export const kunNotxCreatedIndexName = (statement: string): string | null =>
  NOTX_CREATED_INDEX_PATTERN.exec(statement)?.[1] ?? null

export const kunParseMigrationFile = (
  fileName: string,
  content: string
): KunMigrationFile | string => {
  const nameMatch = FILE_NAME_PATTERN.exec(fileName)
  if (!nameMatch) {
    return `${fileName}: 文件名须为 NNNN_slug.sql 或 NNNN_slug.notx.sql (slug 只含小写字母、数字、下划线)`
  }
  const [, version, slug, notxSuffix] = nameMatch
  const mode: KunMigrationMode = notxSuffix ? 'notx' : 'tx'

  // 仓库里 CRLF 与 LF 混用, 同一个文件在两台机器上必须算出同一个 checksum
  const sql = content.replace(/\r\n/g, '\n')
  const lines = sql.split('\n')

  let phase: KunMigrationPhase = 'pre'
  let lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS[mode]
  let statementTimeoutMs: number | null = null
  const seenDirectives = new Set<string>()

  let headerEnd = 0
  for (; headerEnd < lines.length; headerEnd++) {
    const line = lines[headerEnd].trim()
    if (line !== '' && !line.startsWith('--')) {
      break
    }
    const directive = DIRECTIVE_PATTERN.exec(line)
    if (!directive) {
      // 默认 phase 是 pre: 指令若被当成普通注释, post 迁移会静默提前到旧代码在线时执行
      if (DIRECTIVE_LIKE_PATTERN.test(line)) {
        return `${fileName}: 指令须写成小写键加半角冒号, 例如「-- phase: post」: ${line}`
      }
      const unknown = UNKNOWN_DIRECTIVE_PATTERN.exec(line)
      if (unknown) {
        return `${fileName}: 未知指令 ${unknown[1]} (可用: phase / lock_timeout / statement_timeout); 普通说明不要写成「单词:」开头`
      }
      continue
    }
    const [, key, rawValue] = directive
    const value = rawValue.trim()
    if (seenDirectives.has(key)) {
      return `${fileName}: 指令 ${key} 重复`
    }
    seenDirectives.add(key)

    if (key === 'phase') {
      if (value !== 'pre' && value !== 'post') {
        return `${fileName}: phase 只能是 pre 或 post, 实为 ${value}`
      }
      phase = value
    } else {
      const duration = parseDuration(value)
      if (duration === null) {
        return `${fileName}: ${key} 须形如 500ms / 5s / 10min, 实为 ${value}`
      }
      if (key === 'lock_timeout') {
        lockTimeoutMs = duration
      } else {
        statementTimeoutMs = duration
      }
    }
  }

  for (const line of lines.slice(headerEnd)) {
    if (DIRECTIVE_LIKE_PATTERN.test(line.trim())) {
      return `${fileName}: 指令必须写在文件头 (首条 SQL 之前): ${line.trim()}`
    }
  }

  if (mode === 'notx') {
    const statements = kunSplitNotxStatements(sql)
    if (typeof statements === 'string') {
      return `${fileName}: ${statements}`
    }
    if (statements.length === 0) {
      return `${fileName}: 没有任何 SQL 语句`
    }
  } else {
    const statements = kunSplitSqlStatements(sql)
    if (statements.length === 0) {
      return `${fileName}: 没有任何 SQL 语句`
    }
    // 文件里自带的 COMMIT 会让台账写入落到事务之外, 「恰好执行一次」就不成立了
    const control = statements.find((statement) =>
      TX_CONTROL_PATTERN.test(statement)
    )
    if (control) {
      return `${fileName}: 执行器已把整个文件包进事务, 不要自带事务控制语句: ${control.slice(0, 40)}`
    }
  }

  return {
    version,
    slug,
    fileName,
    phase,
    mode,
    lockTimeoutMs,
    statementTimeoutMs,
    sql,
    checksum: createHash('sha256').update(sql).digest('hex')
  }
}

// 迁移在每个环境严格按版本号递增执行: 一个迁移可以假定比它小的版本都已执行。
// 所以按阶段执行时, 另一阶段若有版本号更小的待执行迁移, 就不能越过它
export const kunPlanMigrations = (
  files: KunMigrationFile[],
  ledger: KunLedgerRow[],
  phase: KunMigrationPhase | 'all'
): KunMigrationPlan => {
  const fail = (
    reason: KunMigrationPlanFailure,
    detail: string
  ): KunMigrationPlan => ({ ok: false, reason, detail })

  // 版本号定长 4 位, 字典序即数值序
  const sorted = [...files].sort((a, b) => a.version.localeCompare(b.version))
  const byVersion = new Map<string, KunMigrationFile>()
  for (const file of sorted) {
    const duplicate = byVersion.get(file.version)
    if (duplicate) {
      return fail(
        'duplicate-version',
        `${duplicate.fileName} 与 ${file.fileName} 版本号相同, 后提交的一方需要重新编号`
      )
    }
    byVersion.set(file.version, file)
  }

  const applied = ledger.filter((row) => row.kind === 'sql')
  for (const row of applied) {
    const file = byVersion.get(row.version)
    if (!file) {
      return fail(
        'applied-file-missing',
        `台账里的版本 ${row.version} 在 db/migrations 下找不到文件`
      )
    }
    if (file.checksum !== row.checksum) {
      return fail(
        'checksum-mismatch',
        `${file.fileName} 在执行之后被改写过; 已执行的迁移不可修改, 请还原并另写新迁移`
      )
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version))
  const pending = sorted.filter((file) => !appliedVersions.has(file.version))

  // 登记行 (baseline) 描述的是既有状态, 各环境早先以任意顺序装出来, 不参与乱序判定
  const maxExecuted = applied
    .filter((row) => !row.baseline)
    .map((row) => row.version)
    .sort()
    .at(-1)
  const outOfOrder =
    maxExecuted !== undefined &&
    pending.find((file) => file.version < maxExecuted)
  if (outOfOrder) {
    return fail(
      'out-of-order',
      `${outOfOrder.fileName} 尚未执行, 但更大的版本 ${maxExecuted} 已执行 (多为分支合并造成), 需要重新编号到末尾`
    )
  }

  if (phase === 'all') {
    return { ok: true, pending }
  }

  const selected = pending.filter((file) => file.phase === phase)
  const firstOther = pending.find((file) => file.phase !== phase)
  const blocked =
    firstOther && selected.find((file) => file.version > firstOther.version)
  if (blocked) {
    return phase === 'pre'
      ? fail(
          'pending-post-before-pre',
          `${blocked.fileName} 之前还有未执行的 post 迁移 ${firstOther.fileName}; 先补跑 --phase post, 或把两者拆成两次部署`
        )
      : fail(
          'pending-pre-before-post',
          `${blocked.fileName} 之前还有未执行的 pre 迁移 ${firstOther.fileName}; 先跑 --phase pre`
        )
  }

  return { ok: true, pending: selected }
}
