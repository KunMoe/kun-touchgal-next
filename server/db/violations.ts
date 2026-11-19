import { Prisma } from '~/prisma/generated/prisma/client'

// 应用层会翻成业务文案的三类 Prisma 已知违例: 唯一约束、外键、目标行不存在。
// 事务里的逐站点文案 (kunTx 的 violations) 与路由边界的通用兜底 (kunRoute) 共用这一份判据
export type KunViolationCode = 'P2002' | 'P2003' | 'P2025'
export type KunViolationMap = Partial<Record<KunViolationCode, string>>

const KUN_VIOLATION_CODES: ReadonlySet<string> = new Set<KunViolationCode>([
  'P2002',
  'P2003',
  'P2025'
])

// 只看类型与 code, 不读 meta: driver adapter 下 meta 里的字段不可靠 (#57)
export const kunViolationCodeOf = (
  error: unknown
): KunViolationCode | undefined =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  KUN_VIOLATION_CODES.has(error.code)
    ? (error.code as KunViolationCode)
    : undefined

// 表里没有的违例返回 undefined, 由调用方原样重抛
export const translateDbViolation = (
  error: unknown,
  map: KunViolationMap
): string | undefined => {
  const code = kunViolationCodeOf(error)
  return code ? map[code] : undefined
}
