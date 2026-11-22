import { prisma } from '~/prisma/index'
import type { LoginIdentifier } from '~/validations/identifier'

// 按登录标识符 (用户名、邮箱) 找人与查重的唯一出处 (T18)。数据库里 name / email 各有一个
// 大小写敏感的 @unique 与一个 lower() 表达式唯一索引 (迁移 0018), 这里的查询都是大小写
// 不敏感的精确匹配, 与 lower() 索引同一个口径。按 id 找人、按库里存的原值回查
// (退订、重置密码对比令牌里的邮箱) 不在这里。lint 的 kun/inv-identity-01/02 拦这个模块
// 之外的同类写法。

// Prisma 把 `{ equals, mode: 'insensitive' }` 编译成不转义的 `ILIKE $1`, 参数里的 `_` / `%`
// 是活通配符 (prisma/prisma#10810、#22072 自 2021 确认未修, 官方文档要求调用方自行转义):
// 库里有 abc@qq.com 时查 a_c@qq.com 会命中它. 用户名放行 `_` 和 `%`, 邮箱正则放行 `_`,
// 所以拿用户输入做大小写不敏感的精确匹配一律经这里. 反斜杠是 Postgres LIKE 的默认转义符.
// 编译形状由 prisma/__tests__/compile-contract.test.ts 守护
export const insensitiveEquals = (value: string) => ({
  equals: value.replace(/[\\%_]/g, '\\$&'),
  mode: 'insensitive' as const
})

// 登录按种类确定性解析。邮箱形态的输入先查 email 列: 有人把用户名改成别人的邮箱时,
// 邮箱的持有者照样登得进去 (以前是一条 OR 加无序的 findFirst, 两行里随机取一行)。
// 查不到才回落到 name 列, 照顾改名规则收紧之前 (server/identity/username.ts) 存量的
// 邮箱形态用户名; 生产统计为 0 之后删掉回落 (统计查询见 docs 里 T18 的任务记录)。
// 用户名形态的输入只查 name 列。每列至多命中一行由 lower() 唯一索引 (迁移 0018) 保证;
// 不加 orderBy: ILIKE 用不上任何索引, 带 ORDER BY id 时 planner 改走主键索引逐行回表,
// 本地生产副本上命中与未命中都慢 2~3 倍 (不带时顺扫命中即停)
export const findUserForLogin = async (identifier: LoginIdentifier) => {
  if (identifier.kind === 'email') {
    const byEmail = await prisma.user.findFirst({
      where: { email: insensitiveEquals(identifier.raw) }
    })
    if (byEmail) {
      return byEmail
    }
  }
  return prisma.user.findFirst({
    where: { name: insensitiveEquals(identifier.raw) }
  })
}

// exceptUid 必填: 调用点要在类型上回答「这次有没有当前用户」。改自己名字的大小写
// (Kun -> KUN) 时不排除自身, 预检就命中本人, 恒报「已经有人注册」(#62)
interface KunTakenOptions {
  exceptUid: number | null
}

const exceptSelf = (exceptUid: number | null) =>
  exceptUid === null ? {} : { id: { not: exceptUid } }

// 预检只负责给出可读的提示; 预检与写入之间的并发窗口由唯一索引兜底 (写入方接 P2002)。
// 不能因为有了索引就删预检: 管理端与改邮箱的写入不在这里, 撞索引只能拿到笼统的冲突文案
export const isUsernameTaken = async (
  name: string,
  { exceptUid }: KunTakenOptions
) => {
  const row = await prisma.user.findFirst({
    where: { name: insensitiveEquals(name), ...exceptSelf(exceptUid) },
    select: { id: true }
  })
  return row !== null
}

export const isEmailTaken = async (
  email: string,
  { exceptUid }: KunTakenOptions
) => {
  const row = await prisma.user.findFirst({
    where: { email: insensitiveEquals(email), ...exceptSelf(exceptUid) },
    select: { id: true }
  })
  return row !== null
}

// 找回密码按邮箱找人: 与登录同一个口径, 用户输入的大小写与注册时不同也能找到
export const findUserByEmailForReset = (email: string) =>
  prisma.user.findFirst({
    where: { email: insensitiveEquals(email) },
    select: { id: true, email: true }
  })
