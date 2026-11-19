export type KunExternalIdSource =
  'vndb' | 'vndbRelation' | 'bangumi' | 'steam' | 'dlsite'

// 外部 ID 的唯一规范化点: 表单的抓取与查重、服务端的预检与入库都经这里,
// 两边各写一份的话, 表单认为相同的 ID 到了服务端可能是另一个值
export const normalizeExternalId = (
  source: KunExternalIdSource,
  raw: string | null | undefined
): string => {
  const value = raw?.trim() ?? ''
  if (source === 'vndb' || source === 'vndbRelation') {
    return value.toLowerCase()
  }
  if (source === 'dlsite') {
    return value.toUpperCase()
  }
  // bangumi / steam 是纯数字, 没有大小写
  return value
}
