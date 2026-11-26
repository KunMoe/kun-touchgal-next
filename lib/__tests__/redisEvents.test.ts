import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

const { redis } = await import('~/lib/redis')
const { kunLog } = await import('~/lib/log.server')

beforeEach(() => {
  vi.mocked(kunLog).mockClear()
})

describe('Redis 客户端的连接事件', () => {
  it('error 记 dep.redis (state=error) 并带上错误', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED'
    })
    redis.emit('error', error)
    expect(kunLog).toHaveBeenCalledWith('dep.redis', { state: 'error' }, error)
  })

  it('reconnecting 记 dep.redis (state=reconnecting)', () => {
    redis.emit('reconnecting', 200)
    expect(kunLog).toHaveBeenCalledWith('dep.redis', { state: 'reconnecting' })
  })

  it('ready 记 dep.redis_ready', () => {
    redis.emit('ready')
    expect(kunLog).toHaveBeenCalledWith('dep.redis_ready')
  })
})
