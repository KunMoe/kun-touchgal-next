import type { Prisma } from '~/prisma/generated/prisma/client'

// 列级分级表: 每一列能不能离开数据访问层由这里决定, 不由每个出口各自手写白名单。
// 被隐藏的列 (contact / secret / telemetry) 经 PrismaClient 的全局 omit 默认不读
// (prisma/createClient.ts): 不带 select 的查询、include 进来的关系、update / create /
// delete 的 RETURNING 都不含它们, 整行进了响应或日志也带不出去。
//
// 取回约定:
//   - 真正要读被隐藏列的地方显式取回: select 里写出这一列, 或 omit: { 列: false }。
//     两种写法的结果类型都精确, 事务内外一样 (kunTx 的 ctx.tx 是带全局 omit 的 KunTx)。
//   - 不要为了「拿到整行」把 omit 关掉; 也不要把 Prisma.TransactionClient 当参数类型,
//     它是不带全局 omit 的类型, 事务里读被隐藏的列会被类型放过、运行时却是 undefined。
//   - updateMany / count / $queryRaw / $executeRaw 不受全局 omit 影响 (它们不返回模型行)。
//
// schema 给 user 加了列、跑过 prisma:generate 之后, 下面的 satisfies 要求先给新列分级。

// public: 任何人可见; self: 本人或管理端可见; contact: 联系方式;
// secret: 凭据, 只在校验处读; telemetry: 运营记录; internal: 只供服务端逻辑使用
export type ColumnClass =
  'public' | 'self' | 'contact' | 'secret' | 'telemetry' | 'internal'

export const USER_COLUMN_CLASS = {
  id: 'public',
  name: 'public',
  avatar: 'public',
  bio: 'public',
  role: 'public',
  status: 'public',
  register_time: 'public',
  moemoepoint: 'public',
  created: 'public',
  email: 'contact',
  password: 'secret',
  two_factor_secret: 'secret',
  two_factor_backup: 'secret',
  ip: 'telemetry',
  last_login_time: 'telemetry',
  enable_email_notice: 'self',
  allow_private_message: 'self',
  blocked_tag_ids: 'self',
  daily_image_count: 'self',
  daily_check_in: 'self',
  daily_upload_size: 'self',
  enable_2fa: 'self',
  avatar_status: 'internal',
  bio_status: 'internal',
  security_stamp: 'internal',
  updated: 'internal'
} as const satisfies Record<Prisma.UserScalarFieldEnum, ColumnClass>

const HIDDEN_CLASSES = ['contact', 'secret', 'telemetry'] as const
type HiddenClass = (typeof HIDDEN_CLASSES)[number]

type HiddenOf<T extends Record<string, ColumnClass>> = {
  [K in keyof T as T[K] extends HiddenClass ? K : never]: true
}

const hiddenOf = <T extends Record<string, ColumnClass>>(table: T) =>
  Object.fromEntries(
    Object.entries(table)
      .filter(([, cls]) => (HIDDEN_CLASSES as readonly string[]).includes(cls))
      .map(([column]) => [column, true])
  ) as HiddenOf<T>

export const KUN_GLOBAL_OMIT = {
  user: hiddenOf(USER_COLUMN_CLASS),
  oidc_client: { client_secret: true }
} as const satisfies Prisma.GlobalOmitConfig
