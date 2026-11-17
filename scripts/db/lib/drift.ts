import { kunSplitSqlStatements } from './migrationFiles'

// 「期望状态」与「库的实际状态」的两种比对, 纯函数:
// 1. db/objects.snapshot.sql —— Prisma schema 看不见的库级对象 (函数、触发器、
//    部分索引与表达式索引、CHECK 约束)。Prisma 7.10 的差异比对完全忽略这四类
// 2. prisma migrate diff 的输出扣掉 db/prisma-diff-allowlist.sql 里的已知噪音

export type KunDbObjectKind = 'function' | 'trigger' | 'index' | 'check'

export interface KunDbObject {
  kind: KunDbObjectKind
  name: string
  definition: string
}

const KIND_ORDER: KunDbObjectKind[] = ['function', 'trigger', 'index', 'check']
const MARKER_PATTERN = /^-- (function|trigger|index|check): (.+)$/

const SNAPSHOT_HEADER = `-- 生成物, 不要手改。由 \`pnpm db:snapshot\` 从空库按序回放 db/migrations 后导出,
-- 只含 Prisma schema 看不见的库级对象: 函数、触发器、部分索引与表达式索引、CHECK 约束。
-- 表、列与普通索引由 \`pnpm db:verify --prisma\` 对照 prisma/schema 比对。
-- \`pnpm db:verify\` 拿各环境的实际对象与本文件逐个比对, 它也是所装对象的版本标识。
`

const objectKey = (object: KunDbObject) => `${object.kind} ${object.name}`

const sortObjects = (objects: KunDbObject[]) =>
  [...objects].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )

export const kunRenderSnapshot = (objects: KunDbObject[]): string =>
  SNAPSHOT_HEADER +
  sortObjects(objects)
    .map(
      (object) =>
        `\n-- ${object.kind}: ${object.name}\n${object.definition.trim()};\n`
    )
    .join('')

export const kunParseSnapshot = (text: string): KunDbObject[] => {
  const objects: KunDbObject[] = []
  let current: { kind: KunDbObjectKind; name: string; lines: string[] } | null =
    null

  const flush = () => {
    if (current) {
      objects.push({
        kind: current.kind,
        name: current.name,
        definition: current.lines.join('\n').trim().replace(/;$/, '')
      })
    }
  }

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const marker = MARKER_PATTERN.exec(line)
    if (marker) {
      flush()
      current = {
        kind: marker[1] as KunDbObjectKind,
        name: marker[2],
        lines: []
      }
    } else if (current) {
      current.lines.push(line)
    }
  }
  flush()

  return objects
}

// 多余的对象与缺失同样算不一致: 旧一代触发器残留并与新一代并存, 计数会翻倍
export const kunDiffObjects = (
  expected: KunDbObject[],
  actual: KunDbObject[]
): string[] => {
  const actualByKey = new Map(
    actual.map((object) => [objectKey(object), object.definition.trim()])
  )
  const expectedKeys = new Set(expected.map(objectKey))
  const problems: string[] = []

  for (const object of sortObjects(expected)) {
    const definition = actualByKey.get(objectKey(object))
    if (definition === undefined) {
      problems.push(`缺失 ${objectKey(object)}`)
    } else if (definition !== object.definition.trim()) {
      problems.push(`定义不同 ${objectKey(object)}`)
    }
  }
  for (const object of sortObjects(actual)) {
    if (!expectedKeys.has(objectKey(object))) {
      problems.push(`多余 ${objectKey(object)}`)
    }
  }

  return problems
}

// stale: 白名单里已不再出现的条目。噪音消失或变形后, 留着它就成了漂移检查的盲区
export const kunFilterPrismaDiff = (
  diffSql: string,
  allowlistSql: string
): { unexpected: string[]; stale: string[] } => {
  const allowlist = kunSplitSqlStatements(allowlistSql)
  const statements = kunSplitSqlStatements(diffSql)

  return {
    unexpected: statements.filter(
      (statement) => !allowlist.includes(statement)
    ),
    stale: allowlist.filter((statement) => !statements.includes(statement))
  }
}
