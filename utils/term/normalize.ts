// 标签 / 会社别名 (含会社的母品牌) 的规范形: 去掉首尾空白再转小写。管理端录入、服务端写入
// 与按别名比较都只经这里, 不在调用点各写一遍 trim().toLowerCase()。toLowerCase 不随运行
// 环境的 locale 变; 库里不用 PG 的 lower(), 两边的大小写映射不保证一致
export const aliasKey = (raw: string): string => raw.trim().toLowerCase()

// 逐项取规范形, 去掉空串, 保序去重
export const normalizeAliasList = (raw: readonly string[]): string[] => [
  ...new Set(raw.map(aliasKey).filter(Boolean))
]

// 按别名比较时拿去比的形态。存量别名里还有没规范化的大小写混合写法, 过渡期同时比 trim 后的
// 原串与规范形。存量由 post 迁移 0020 回填; 它在生产执行完之后的下一个版本才收紧为只返回规范形
// (同一个版本里收紧, 切换到 post 迁移执行完之间会有一段按原大小写搜不到存量别名)
export const aliasLookupForms = (raw: string): string[] => {
  const trimmed = raw.trim()
  const key = trimmed.toLowerCase()
  return trimmed === key ? [key] : [trimmed, key]
}

// 一组输入的全部比较形态, 去重后交给 Prisma 的 hasSome
export const aliasLookupFormsOf = (inputs: readonly string[]): string[] => [
  ...new Set(inputs.flatMap(aliasLookupForms))
]
