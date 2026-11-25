import { createHash } from 'crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '~/prisma/generated/prisma/client'
import { KUN_GLOBAL_OMIT } from '~/prisma/columnPolicy'
import type { ITXClientDenyList } from '@prisma/client/runtime/client'
import type pg from 'pg'

// 名字必须由 SQL 文本确定性派生: pg 按 name 在每条连接上缓存已 Parse 的语句且从不
// DEALLOCATE, 同名异文会直接抛错, 因此名字既不能复用也不能随淘汰变化。
// sha1 十六进制 40 字符, 低于 PostgreSQL 语句名 63 字符上限。
export const statementNameGenerator = (query: { sql: string }) =>
  createHash('sha1').update(query.sql).digest('hex')

// 全仓唯一构造 PrismaClient 的地方。本模块不读环境变量、不建连接池: 应用的单例
// (prisma/index.ts) 与编译契约测试的录制客户端 (prisma/__tests__/support/sqlRecorder.ts)
// 各自把池交进来, adapter 的选项只在这里写一次, 测试录到的 SQL 才与线上同源。
// 全局 omit 来自列级分级表 (prisma/columnPolicy.ts), 回滚只需去掉这一个选项
export const createKunPrismaClient = (pool: pg.Pool) =>
  new PrismaClient({
    adapter: new PrismaPg(pool, { statementNameGenerator }),
    omit: KUN_GLOBAL_OMIT
  })

// 带全局 omit 的客户端类型。KunTx 是事务回调拿到的客户端: 运行时的 tx 同样带全局 omit,
// 而 Prisma 自带的 Prisma.TransactionClient 是不带 omit 的默认类型, 事务内读被隐藏的列
// 会被它放过。需要「顶层客户端或事务」的 helper 参数一律写 KunTx (KunDb 也能赋给它)
export type KunDb = ReturnType<typeof createKunPrismaClient>
export type KunTx = Omit<KunDb, ITXClientDenyList>
