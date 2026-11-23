import { expect } from 'vitest'
import { statementNameGenerator } from '~/prisma/createClient'
import type { RecordedStatement } from '~/prisma/__tests__/support/sqlRecorder'

// 对录到的 SQL 断言「性质」, 不做逐字节快照: 上游换参数编号、调整括号或列顺序不该让它变红,
// 承重的那条性质不再成立时才该红。变红之后由人判断新形状是否仍满足被依赖的前提
// (各断言的注释写明了前提是什么), 不要机械地改断言去迁就新输出。
//
// 每个断言都先找到自己要看的那条语句, 找不到即失败, 不会在空集合上通过。

const collapse = (sql: string) => sql.replace(/\s+/g, ' ').trim()

// 带引号的标识符换成占位, 关键字检查才不会被叫 "with_spoiler" 之类的列名误伤
const withoutIdentifiers = (sql: string) => sql.replace(/"(?:[^"]|"")*"/g, '""')

// 括号深度为 0、且不在带引号的标识符内的第一个 keyword 的位置
const findTopLevel = (sql: string, keyword: string, from = 0) => {
  let depth = 0
  let quoted = false
  for (let i = from; i < sql.length; i++) {
    const char = sql[i]
    if (char === '"') {
      quoted = !quoted
    } else if (!quoted) {
      if (char === '(') {
        depth++
      } else if (char === ')') {
        depth--
      } else if (depth === 0 && sql.startsWith(keyword, i)) {
        return i
      }
    }
  }
  return -1
}

const matchingParen = (sql: string, open: number) => {
  let depth = 0
  let quoted = false
  for (let i = open; i < sql.length; i++) {
    const char = sql[i]
    if (char === '"') {
      quoted = !quoted
    } else if (!quoted) {
      if (char === '(') {
        depth++
      } else if (char === ')' && --depth === 0) {
        return i
      }
    }
  }
  return sql.length
}

// 剥掉把整个表达式包起来的那一层括号
const unwrap = (expression: string) =>
  expression.startsWith('(') &&
  matchingParen(expression, 0) === expression.length - 1
    ? expression.slice(1, -1)
    : expression

const splitTopLevel = (expression: string, separator: string) => {
  const parts: string[] = []
  let from = 0
  for (
    let at = findTopLevel(expression, separator);
    at !== -1;
    at = findTopLevel(expression, separator, from)
  ) {
    parts.push(expression.slice(from, at))
    from = at + separator.length
  }
  return [...parts, expression.slice(from)]
}

const targets = (sql: string, verb: string, table: string) =>
  new RegExp(`^${verb} (?:"[^"]+"\\.)?"${table}"(?: |$)`).test(collapse(sql))

// 事务控制语句之外的语句。「这次调用只发了一条语句」数的是它们: 上游把不把单条写包进
// BEGIN / COMMIT (7.9 以前包, 7.10 起不包) 不影响下面任何一条前提
export const dataStatements = (statements: RecordedStatement[]) =>
  statements.filter(
    ({ sql }) =>
      !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|SET TRANSACTION)\b/.test(
        sql
      )
  )

// 条件更新当 CAS 用的前提: 守卫由这条 UPDATE 自己的 WHERE 在目标行上求值。
// READ COMMITTED 下后到者在行锁上等待, 拿到锁后库只对「目标表这一行」重新求值 WHERE;
// 守卫若被编译进子查询 (WHERE id IN (SELECT …) / EXISTS / JOIN), 那是另一个扫描节点,
// 仍用语句起始时的快照, 并发者会一起通过。所以要求: 恰好一条对该表的 UPDATE, 它的 WHERE
// 里没有任何子查询或连接, 每个守卫列都以「列 比较符 参数」的形式作为 WHERE 的一个合取条件
// (与别的条件 OR 在一起的不算: 那样它拦不住任何一行)
export const expectFlatConditionalUpdate = (
  statements: RecordedStatement[],
  { table, guards }: { table: string; guards: string[] }
) => {
  const updates = statements.filter((statement) =>
    targets(statement.sql, 'UPDATE', table)
  )
  expect(updates, `应当恰好有一条对 ${table} 的 UPDATE`).toHaveLength(1)

  const sql = collapse(updates[0].sql)
  const whereAt = findTopLevel(sql, ' WHERE ')
  expect(whereAt, `对 ${table} 的 UPDATE 没有 WHERE`).toBeGreaterThan(-1)
  expect(
    withoutIdentifiers(sql.slice(0, whereAt)),
    `对 ${table} 的 UPDATE 连接了别的关系`
  ).not.toMatch(/\bFROM\b/i)

  const returningAt = findTopLevel(sql, ' RETURNING ', whereAt)
  const where = sql.slice(
    whereAt + ' WHERE '.length,
    returningAt === -1 ? undefined : returningAt
  )
  expect(
    withoutIdentifiers(where),
    `对 ${table} 的 UPDATE 把条件编译进了子查询或连接, 并发下库不会重新求值它`
  ).not.toMatch(/\b(SELECT|EXISTS|JOIN|WITH|FROM)\b/i)
  const conjuncts = splitTopLevel(unwrap(where), ' AND ')
  for (const guard of guards) {
    const comparison = new RegExp(
      `^(?:"[^"]+"\\.)?"${table}"\\."${guard}" (?:=|<>|<=|>=|<|>) \\$\\d+$`
    )
    expect(
      conjuncts.some((conjunct) => comparison.test(conjunct)),
      `守卫列 ${guard} 不是 UPDATE 自己的 WHERE 里的一个合取条件`
    ).toBe(true)
  }

  return updates[0]
}

// 单条 DELETE … RETURNING: 返回值就是删除那一刻的行。两处资源删除如今先 FOR UPDATE 再删,
// 不再靠这条性质闭合竞态, 留着只为记录形状
export const expectSingleDeleteReturning = (
  statements: RecordedStatement[],
  table: string
) => {
  const sent = dataStatements(statements)
  expect(sent, 'delete 应当只发一条语句').toHaveLength(1)
  expect(targets(sent[0].sql, 'DELETE FROM', table)).toBe(true)
  expect(collapse(sent[0].sql)).toMatch(/ RETURNING /)
}

interface AggregateSubquery {
  table: string
  // 子查询里连接进来的表: 别名 -> 表名
  joined: Map<string, string>
  // WHERE 的各个顶层合取条件
  conjuncts: string[]
}

// 关系 _count 被编译成 LEFT JOIN (SELECT 外键, COUNT(*) FROM 子表 [LEFT JOIN 父表 AS 别名 …]
// [WHERE …] GROUP BY 外键)。取出每个这样的聚合子查询聚合的是哪张表、连了谁、带着什么条件
const aggregateSubqueries = (statements: RecordedStatement[]) => {
  const found: AggregateSubquery[] = []
  for (const statement of statements) {
    const sql = collapse(statement.sql)
    let open = sql.indexOf('(SELECT ')
    for (; open !== -1; open = sql.indexOf('(SELECT ', open + 1)) {
      const body = sql.slice(open + 1, matchingParen(sql, open))
      const fromAt = findTopLevel(body, ' FROM ')
      const groupAt = findTopLevel(body, ' GROUP BY ')
      if (
        fromAt === -1 ||
        groupAt === -1 ||
        !/\bCOUNT\(/.test(body.slice(0, fromAt))
      ) {
        continue
      }
      const whereAt = findTopLevel(body, ' WHERE ', fromAt)
      const source = body.slice(
        fromAt + ' FROM '.length,
        whereAt === -1 ? groupAt : whereAt
      )
      found.push({
        table: /^(?:"[^"]+"\.)?"([^"]+)"/.exec(source)?.[1] ?? '',
        joined: new Map(
          [
            ...source.matchAll(/JOIN (?:"[^"]+"\.)?"([^"]+)" AS "([^"]+)"/g)
          ].map(([, table, alias]) => [alias, table])
        ),
        conjuncts:
          whereAt === -1
            ? []
            : splitTopLevel(
                unwrap(body.slice(whereAt + ' WHERE '.length, groupAt)),
                ' AND '
              )
      })
    }
  }
  return found
}

// 「对返回行恒真」的关系过滤的作用: 让聚合子查询带上「父表的某一列 = 参数」这个条件,
// 库才能按索引只聚合相关的行。要求: 对 relationTable 的每个聚合子查询都连接了 parentTable,
// 并以它的 predicateColumn = 参数 作为 WHERE 的一个合取条件 (落在子表自己的列上的不算:
// 那是在改变数出来的结果, 不是恒真过滤)
export const expectAggregatePushdown = (
  statements: RecordedStatement[],
  {
    relationTable,
    parentTable,
    predicateColumn
  }: { relationTable: string; parentTable: string; predicateColumn: string }
) => {
  const aggregates = aggregateSubqueries(statements).filter(
    ({ table }) => table === relationTable
  )
  expect(
    aggregates.length,
    `没有找到对 ${relationTable} 的聚合子查询`
  ).toBeGreaterThan(0)
  for (const { joined, conjuncts } of aggregates) {
    const pushed = conjuncts.some((conjunct) => {
      const alias = new RegExp(
        `^"([^"]+)"\\."${predicateColumn}" = \\$\\d+$`
      ).exec(conjunct)?.[1]
      return alias !== undefined && joined.get(alias) === parentTable
    })
    expect(
      pushed,
      `对 ${relationTable} 的聚合没有带上 ${parentTable}.${predicateColumn} 条件, 会整表 GROUP BY`
    ).toBe(true)
  }
}

// 没有被「连接进来的某张父表的一列 = 参数」限定的聚合子查询所聚合的表 (不带过滤时 Prisma
// 写成 WHERE 1=1)。对列表查询来说, 这就是每次查询都把这张表整个 GROUP BY 一遍。
// 落在子表自己的列上的条件 (status = $1 这类) 不算限定: 它筛掉一些行, 但只看 SQL 文本分不清
// 库是按索引取一小段还是扫完整张表再筛, 所以宁可多报, 报出来的由人看过再登记。
// 按连接键取单行的查询里库能把外层的常量推进聚合, 这个判据同样看不出来, 所以只拿它看列表查询
export const wholeTableAggregates = (statements: RecordedStatement[]) =>
  aggregateSubqueries(statements)
    .filter(
      ({ joined, conjuncts }) =>
        !conjuncts.some((conjunct) => {
          const alias = /^"([^"]+)"\."[^"]+" = \$\d+$/.exec(conjunct)?.[1]
          return alias !== undefined && joined.has(alias)
        })
    )
    .map(({ table }) => table)

// Prisma 把 { equals, mode: 'insensitive' } 编译成不带 ESCAPE 子句的 ILIKE, 参数里的 _ 和 %
// 是活的通配符, 调用方要先转义。要求: 该列确实走 ILIKE, 绑定的参数恰是 bound
// (调用方转义后的串, 不多转一层也不少转一层)
export const expectEscapedIlike = (
  statements: RecordedStatement[],
  { column, bound }: { column: string; bound: string }
) => {
  const pattern = new RegExp(`"${column}" ILIKE \\$(\\d+)(?!\\d| ESCAPE)`, 'g')
  const values = statements.flatMap((statement) =>
    [...collapse(statement.sql).matchAll(pattern)].map(
      ([, index]) => statement.values[Number(index) - 1]
    )
  )
  expect(values.length, `没有找到对 ${column} 的 ILIKE`).toBeGreaterThan(0)
  for (const value of values) {
    expect(value).toBe(bound)
  }
}

// server/identity/lookup.ts 按用户名或邮箱找人的那条原生查询: lower(列) = lower(参数),
// 走迁移 0018 的 lower() 唯一索引。要求: 这批语句里对 name / email 的匹配恰好是这一处
// (没有 ILIKE, 那是用不上索引的写法), 列是 column, 绑定的参数恰是 bound (原样, 不转义也
// 不预先小写)。返回那条语句
export const expectLowerEquals = (
  statements: RecordedStatement[],
  { column, bound }: { column: 'name' | 'email'; bound: string }
) => {
  const matches = statements.flatMap((statement) =>
    [
      ...collapse(statement.sql).matchAll(
        /lower\((name|email)\) = lower\(\$(\d+)::text\)/g
      )
    ].map(([, matched, index]) => ({
      statement,
      column: matched,
      value: statement.values[Number(index) - 1]
    }))
  )
  expect(
    statements.filter(({ sql }) => /"(name|email)" ILIKE/.test(sql)),
    '不应再有对 name / email 的 ILIKE'
  ).toEqual([])
  expect(
    matches.map(({ column, value }) => ({ column, value })),
    `应当恰好一处 lower(${column}) = lower($n::text)`
  ).toEqual([{ column, value: bound }])
  return matches[0].statement
}

// 事务级通告锁、行锁与条件更新要互相看得见, 必须与 BEGIN / COMMIT 发在同一条连接上。
// 要求: 这批语句里恰好一个事务, 它的连接不是自动提交通道, 以 BEGIN 开头、COMMIT 结尾,
// inner 的每个 pattern 依次命中其间的一条语句。返回其间的全部语句
export const expectSameClientTransaction = (
  statements: RecordedStatement[],
  inner: RegExp[]
) => {
  const begins = statements.filter(({ sql }) => sql === 'BEGIN')
  expect(begins, '应当恰好开启一个事务').toHaveLength(1)
  const { clientId } = begins[0]
  expect(clientId, '事务不应发在自动提交通道上').not.toBe(0)

  const onClient = statements.filter(
    (statement) => statement.clientId === clientId
  )
  expect(onClient[0].sql).toBe('BEGIN')
  expect(onClient.at(-1)?.sql, '事务没有以 COMMIT 结束').toBe('COMMIT')

  const body = onClient.slice(1, -1)
  expect(body.every((statement) => statement.inTransaction)).toBe(true)
  let cursor = 0
  for (const pattern of inner) {
    const at = body.findIndex(
      (statement, index) =>
        index >= cursor && pattern.test(collapse(statement.sql))
    )
    expect(at, `事务里没有按顺序找到 ${pattern}`).toBeGreaterThan(-1)
    cursor = at + 1
  }
  return body
}

// pg 按语句名在每条连接上缓存已解析的语句, 名字必须由 SQL 文本确定性派生
// (prisma/createClient.ts)。要求: 每条语句都带着由它自己的文本派生的名字 ——
// 工厂漏传生成器时 name 是 undefined
export const expectStatementNames = (statements: RecordedStatement[]) => {
  expect(statements.length).toBeGreaterThan(0)
  for (const { sql, name } of statements) {
    expect(name, `语句没有带上派生的名字: ${collapse(sql)}`).toBe(
      statementNameGenerator({ sql })
    )
  }
}
