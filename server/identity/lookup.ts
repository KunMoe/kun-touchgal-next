import { Prisma } from '~/prisma/generated/prisma/client'
import { prisma } from '~/prisma/index'
import type { LoginIdentifier } from '~/validations/identifier'

// 按登录标识符 (用户名、邮箱) 找人与查重的唯一出处 (T18)。数据库里 name / email 各有一个
// 大小写敏感的 @unique 与一个 lower() 表达式唯一索引 (迁移 0018)。这里的匹配一律是
// lower(列) = lower(输入): 与那条索引是同一个判定, 也走那条索引。按 id 找人、按库里存的
// 原值回查 (退订、重置密码对比令牌里的邮箱) 不在这里。lint 的 kun/inv-identity-02 拦这个
// 模块之外按 name / email 精确匹配的 user 查询。
//
// 不用 Prisma 的 `{ equals, mode: 'insensitive' }`: 它编译成 ILIKE, 用不上任何 btree 索引
// (本地 62 万行的生产副本上每次顺扫全表, 命中约 70 ms、未命中约 170 ms; 走索引约 1.5 ms),
// 参数里的 `_` / `%` 还是活的通配符 (prisma/prisma#10810)。Prisma 的 where 写不出 lower(),
// 所以用原生 SQL 按索引取 id, 要整行时再按主键取。等号是字面比较, `_` `%` `\` 没有特殊
// 含义, 输入原样绑定: 不转义, 也不预先小写 (两侧用同一个库内的 lower() 折叠)

const LOWER_COLUMN = {
  name: Prisma.sql`lower(name)`,
  email: Prisma.sql`lower(email)`
}

// exceptUid 为 null 时 `id IS DISTINCT FROM NULL` 对每一行都成立, 即不排除任何人。
// 导出只为真库用例对这条语句做 EXPLAIN: 它必须走 lower() 唯一索引
export const userIdByLowerSql = (
  column: keyof typeof LOWER_COLUMN,
  value: string,
  exceptUid: number | null
) => Prisma.sql`
  SELECT id FROM "user"
  WHERE ${LOWER_COLUMN[column]} = lower(${value}::text)
    AND id IS DISTINCT FROM ${exceptUid}::int4
  LIMIT 1`

const userIdByLower = async (
  ...args: Parameters<typeof userIdByLowerSql>
): Promise<number | null> => {
  const [row] = await prisma.$queryRaw<{ id: number }[]>(
    userIdByLowerSql(...args)
  )
  return row?.id ?? null
}

// 登录按种类确定性解析, 每种只查一列: 邮箱形态的输入只查 email 列, 用户名形态的只查
// name 列。有人把用户名改成别人的邮箱时, 邮箱的持有者照样登得进去 (以前是一条 OR 加
// 无序的 findFirst, 两行里随机取一行)。邮箱形态的名字没法拿来登录, 所以取新名字时不许
// 邮箱形态 (server/identity/username.ts)。以前查不到邮箱还会回落到 name 列, 照顾这类
// 存量; 生产统计存量为 0 之后删了。每列至多命中一行由 lower() 唯一索引保证
export const findUserForLogin = async ({ kind, raw }: LoginIdentifier) => {
  const id = await userIdByLower(kind, raw, null)
  return id === null ? null : prisma.user.findUnique({ where: { id } })
}

// exceptUid 必填: 调用点要在类型上回答「这次有没有当前用户」。改自己名字的大小写
// (Kun -> KUN) 时不排除自身, 预检就命中本人, 恒报「已经有人注册」(#62)
interface KunTakenOptions {
  exceptUid: number | null
}

// 预检只负责给出可读的提示; 预检与写入之间的并发窗口由唯一索引兜底 (写入方接 P2002)。
// 不能因为有了索引就删预检: 管理端与改邮箱的写入不在这里, 撞索引只能拿到笼统的冲突文案
export const isUsernameTaken = async (
  name: string,
  { exceptUid }: KunTakenOptions
) => (await userIdByLower('name', name, exceptUid)) !== null

export const isEmailTaken = async (
  email: string,
  { exceptUid }: KunTakenOptions
) => (await userIdByLower('email', email, exceptUid)) !== null

// 找回密码按邮箱找人: 与登录同一个口径, 用户输入的大小写与注册时不同也能找到
export const findUserByEmailForReset = async (email: string) => {
  const id = await userIdByLower('email', email, null)
  return id === null
    ? null
    : prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true }
      })
}
