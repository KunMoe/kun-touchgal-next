import * as z from 'zod'
import { INT4_MAX } from '~/constants/db-limits'

// 数值入参的值域只在这里定 (T27)。z.coerce.number() 默认放行小数, 而 Prisma 会把 Int 字段上的
// 5.5 静默截成 5: 守卫、Redis 键、raw SQL 的 ::int 用原值, 落库用截断值, 两边悄悄分叉
// (小数 uid 绕过「不能关注自己」就是这样来的)。所以落 Int 列的字段一律用 kunInt / kunId,
// 确实允许小数、也不落 Int 列的字段 (跳转延时) 才用 kunNumber。
//
// - <number> 泛型承重: 表单与 API 复用的 schema 靠它把输入类型定为 number, 删了是 unknown。
// - 只传 { message }: 与 { error } 同传会在运行时抛错。schema 级文案由它的各项检查继承,
//   一条中文覆盖「不是数字」「不是整数」「越界」三种失败, 数字由参数插进文案。
// - coerce 的宽松语义照旧: '1e3' 是 1000, '0x10' 是 16 (#68 刻意保留)。

// 页码不是列, 上界只是防住离谱的 skip; 与历来的 9999999 一致
export const KUN_MAX_PAGE = 9999999

export const kunInt = (min: number, max: number, message: string) =>
  z.coerce.number<number>({ message }).int().min(min).max(max)

export const kunNumber = (min: number, max: number, message: string) =>
  z.coerce.number<number>({ message }).min(min).max(max)

// 主键的上界取 int4 的类型边界, 不取业务上限: 绑死业务上限会在表增长后误伤真实的行。
// label 形如「评论 ID」
export const kunId = (label: string) => kunInt(1, INT4_MAX, `${label} 无效`)

export const kunPage = () => kunInt(1, KUN_MAX_PAGE, '页码无效')

export const kunLimit = (max: number) =>
  kunInt(1, max, `每页数量须为 1～${max} 的整数`)
