// PostgreSQL int4 (Prisma 的 Int) 的取值范围。纯数据、零导入, 客户端也能用。
// 越界的值进了 Prisma 查询或写入会抛 P2020, 冒泡到路由就是 500
export const INT4_MAX = 2147483647
export const INT4_MIN = -2147483648
