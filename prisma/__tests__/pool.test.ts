import { describe, expect, it, vi } from 'vitest'

const { poolOptions } = vi.hoisted(() => ({
  poolOptions: [] as Record<string, unknown>[]
}))

vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(options: Record<string, unknown>) {
        poolOptions.push(options)
      }
    }
  }
}))
vi.mock('~/prisma/createClient', () => ({
  createKunPrismaClient: () => ({}),
  statementNameGenerator: () => ''
}))

await import('~/prisma/index')

describe('应用的 PG 连接池', () => {
  // 对端消失时挂着的查询要能报错: 心跳租约下, 等下去的作业会一直占着它的锁
  it('开 TCP keepalive, 空闲 10 秒后发首个探测', () => {
    expect(poolOptions).toHaveLength(1)
    expect(poolOptions[0]).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000
    })
  })
})
