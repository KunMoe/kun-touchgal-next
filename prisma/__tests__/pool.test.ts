import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'

const { pools } = vi.hoisted(() => ({
  pools: [] as { options: Record<string, unknown>; pool: EventEmitter }[]
}))

vi.mock('pg', async () => {
  const { EventEmitter } = await import('events')
  return {
    default: {
      Pool: class extends EventEmitter {
        constructor(options: Record<string, unknown>) {
          super()
          pools.push({ options, pool: this })
        }
      }
    }
  }
})
vi.mock('~/prisma/createClient', () => ({
  createKunPrismaClient: () => ({}),
  statementNameGenerator: () => ''
}))
vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

await import('~/prisma/index')
const { kunLog } = await import('~/lib/log.server')

describe('应用的 PG 连接池', () => {
  // 对端消失时挂着的查询要能报错: 心跳租约下, 等下去的作业会一直占着它的锁
  it('开 TCP keepalive, 空闲 10 秒后发首个探测', () => {
    expect(pools).toHaveLength(1)
    expect(pools[0].options).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000
    })
  })

  it('空闲连接上的错误记 dep.pg_pool_error, 不让进程因未监听的 error 事件退出', () => {
    const error = new Error(
      'terminating connection due to administrator command'
    )
    expect(() => pools[0].pool.emit('error', error)).not.toThrow()
    expect(kunLog).toHaveBeenCalledWith('dep.pg_pool_error', {}, error)
  })
})
