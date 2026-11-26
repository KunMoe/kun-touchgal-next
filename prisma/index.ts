import 'dotenv/config'
import pg from 'pg'
import {
  createKunPrismaClient,
  statementNameGenerator
} from '~/prisma/createClient'
import { isPrismaTransactionConflict } from '~/server/db/txErrors'
import { kunLog } from '~/lib/log.server'

const connectionString = `${process.env.KUN_DATABASE_URL}`

const pool = new pg.Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // 连接上的 TCP keepalive: 对端消失 (网络把连接黑洞掉、库所在的主机宕机) 时, 挂在这条连接上的
  // 查询最终报错, 而不是永远等下去 —— 心跳租约下, 等下去的作业会一直占着它的锁, 直到停滞看门狗
  // 放开 (server/jobs/lease.ts)。首个探测在连接空闲 10 秒后发, 之后的间隔与次数取系统默认 (Linux
  // 75 秒 × 9 次, 约 11 分钟判死)。库在算的长查询不受影响: 对端的 TCP 栈照样应答探测。
  // 没设 query_timeout: 最长的合法查询还没在生产上确认
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  // 空闲取用是 LIFO, 最热的连接在有流量期间永不空闲; 定期回收给每条连接上
  // 只增不减的 prepared statement (实测 24~63 KB/条) 一个时间上界。
  maxLifetimeSeconds: 1800
})

// 空闲连接上的错误 (库重启、连接被对端掐断): adapter 自己的监听只进 debug, 这里记一条节流后的
// error。adapter 在 dispose 时只摘掉它自己的那个监听
pool.on('error', (error) => kunLog('dep.pg_pool_error', {}, error))

const prisma = createKunPrismaClient(pool)

export type { KunDb, KunTx } from '~/prisma/createClient'
export { isPrismaTransactionConflict, prisma, statementNameGenerator }
