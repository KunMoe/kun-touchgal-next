import { Prisma } from '~/prisma/generated/prisma/client'

// 状态码以字面量进 SQL, 不当绑定参数: 文本与改用常量之前逐字相同, 计划与 SQL 形状测试都不变。
// 入参只来自 constants/contentStatus.ts 的常量 (数字), 没有注入面
export const statusSql = (...codes: number[]) => Prisma.raw(codes.join(', '))
