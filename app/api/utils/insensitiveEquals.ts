// Prisma 把 `{ equals, mode: 'insensitive' }` 编译成不转义的 `ILIKE $1`, 参数里的 `_` / `%`
// 是活通配符 (prisma/prisma#10810、#22072 自 2021 确认未修, 官方文档要求调用方自行转义):
// 库里有 abc@qq.com 时查 a_c@qq.com 会命中它. 用户名正则放行 `_` 和 `%`, 邮箱正则放行 `_`,
// 所以拿用户输入做大小写不敏感的精确匹配一律经这里. 反斜杠是 Postgres LIKE 的默认转义符.
export const insensitiveEquals = (value: string) => ({
  equals: value.replace(/[\\%_]/g, '\\$&'),
  mode: 'insensitive' as const
})
