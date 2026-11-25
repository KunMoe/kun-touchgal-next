import { expect } from 'vitest'

// 在一行上求值可见性 WHERE 片段的小求值器, 只认内容可见性用到的几种形状 (标量相等、in、OR、AND、
// 可空外键为 null、to-one 关系的 is)。测试拿它比语义, 不比写法; 认不出的形状直接让测试失败
export type ContentWhereRow = {
  status: number
  user_id: number
  resource_id?: number | null
  resource?: ContentWhereRow | null
  // id、patch_id 这类按标量相等比较的列
  [column: string]: unknown
}

type Where = Record<string, unknown>

export const matchesContentWhere = (
  where: Where,
  row: ContentWhereRow
): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === 'OR') {
      return (value as Where[]).some((w) => matchesContentWhere(w, row))
    }
    if (key === 'AND') {
      return (value as Where[]).every((w) => matchesContentWhere(w, row))
    }
    if (key === 'resource') {
      const { is, ...rest } = value as { is: Where }
      expect(rest).toEqual({})
      return !!row.resource && matchesContentWhere(is, row.resource)
    }
    const actual = row[key] ?? null
    if (value === null || typeof value === 'number') {
      return actual === value
    }
    const { in: list, ...rest } = value as { in?: number[] }
    expect(rest).toEqual({})
    return list!.includes(actual as number)
  })
