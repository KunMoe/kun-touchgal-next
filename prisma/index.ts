import 'dotenv/config'
import pg from 'pg'
import {
  createKunPrismaClient,
  statementNameGenerator
} from '~/prisma/createClient'
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

const prisma = createKunPrismaClient(pool)

export type { KunDb, KunTx } from '~/prisma/createClient'
export { isPrismaTransactionConflict, prisma, statementNameGenerator }
