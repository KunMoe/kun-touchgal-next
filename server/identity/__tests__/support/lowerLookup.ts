// 单测 mock 掉 ~/prisma/index 时, 替 server/identity/lookup.ts 发出的那条原生 SQL
// (userIdByLowerSql) 作答: 认出查哪一列、绑定的值与要排除的 uid, 在给定的行里匹配。
// 这里不导入 lookup (假对象在 vi.hoisted 里建, 那时导入会在 vi.mock 生效之前把真的
// ~/prisma/index 带进来), 所以按语句原文认; lookup 改了语句这里就认不出、直接抛错,
// 免得假对象静默回空让用例照样通过。真库上的判定由 userIdentifier.db.test.ts 守护

const LOWER_LOOKUP =
  /^SELECT id FROM "user" WHERE lower\((name|email)\) = lower\(\$1::text\) AND id IS DISTINCT FROM \$2::int4 LIMIT 1$/

export interface LowerLookup {
  column: 'name' | 'email'
  value: string
  exceptUid: number | null
}

export const parseLowerLookup = (query: unknown): LowerLookup => {
  const { text, values } = (query ?? {}) as { text?: unknown; values?: unknown }
  const match =
    typeof text === 'string'
      ? LOWER_LOOKUP.exec(text.replace(/\s+/g, ' ').trim())
      : null
  const [value, exceptUid] = Array.isArray(values) ? values : []
  if (
    !match ||
    !Array.isArray(values) ||
    values.length !== 2 ||
    typeof value !== 'string' ||
    !(exceptUid === null || typeof exceptUid === 'number')
  ) {
    throw new Error(`lowerLookup: 认不出的原生查询 ${String(text)}`)
  }
  return { column: match[1] as LowerLookup['column'], value, exceptUid }
}

// $queryRaw 的结果形状。JS 的 toLowerCase 代替库里的 lower(): 用例里只放两边折叠结果
// 相同的字符 (ASCII 与常见字母)
export const answerLowerLookup = (
  rows: Iterable<{ id: number; name: string; email: string }>,
  query: unknown
) => {
  const { column, value, exceptUid } = parseLowerLookup(query)
  const wanted = value.toLowerCase()
  const hit = [...rows].find(
    (row) => row.id !== exceptUid && row[column].toLowerCase() === wanted
  )
  return hit ? [{ id: hit.id }] : []
}
