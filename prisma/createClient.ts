import { createHash } from 'crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '~/prisma/generated/prisma/client'
import type pg from 'pg'

// 名字必须由 SQL 文本确定性派生: pg 按 name 在每条连接上缓存已 Parse 的语句且从不
// DEALLOCATE, 同名异文会直接抛错, 因此名字既不能复用也不能随淘汰变化。
// sha1 十六进制 40 字符, 低于 PostgreSQL 语句名 63 字符上限。
export const statementNameGenerator = (query: { sql: string }) =>
  createHash('sha1').update(query.sql).digest('hex')

// 全仓唯一构造 PrismaClient 的地方。本模块不读环境变量、不建连接池: 应用的单例
// (prisma/index.ts) 与编译契约测试的录制客户端 (prisma/__tests__/support/sqlRecorder.ts)
// 各自把池交进来, adapter 的选项只在这里写一次, 测试录到的 SQL 才与线上同源
export const createKunPrismaClient = (pool: pg.Pool) =>
  new PrismaClient({ adapter: new PrismaPg(pool, { statementNameGenerator }) })
