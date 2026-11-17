import 'dotenv/config'
import { createHash } from 'crypto'
import pg from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client'
import { isPrismaTransactionConflict } from '~/server/db/txErrors'

const connectionString = `${process.env.KUN_DATABASE_URL}`

const pool = new pg.Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // 空闲取用是 LIFO, 最热的连接在有流量期间永不空闲; 定期回收给每条连接上
  // 只增不减的 prepared statement (实测 24~63 KB/条) 一个时间上界。
  maxLifetimeSeconds: 1800
})

// 名字必须由 SQL 文本确定性派生: pg 按 name 在每条连接上缓存已 Parse 的语句且从不
// DEALLOCATE, 同名异文会直接抛错, 因此名字既不能复用也不能随淘汰变化。
// sha1 十六进制 40 字符, 低于 PostgreSQL 语句名 63 字符上限。
const statementNameGenerator = (query: { sql: string }) =>
  createHash('sha1').update(query.sql).digest('hex')

const adapter = new PrismaPg(pool, { statementNameGenerator })
const prisma = new PrismaClient({ adapter })

export { isPrismaTransactionConflict, prisma, statementNameGenerator }
