import { beforeEach, describe, expect, it, vi } from 'vitest'
import { KUN_MODERATION_HEALTH_KEY } from '~/config/redis'

const { getKvMock, setKvMock } = vi.hoisted(() => ({
  getKvMock: vi.fn(),
  setKvMock: vi.fn()
}))

vi.mock('~/lib/redis', () => ({ getKv: getKvMock, setKv: setKvMock }))
vi.mock('~/lib/log.server', () => ({ kunLog: vi.fn() }))

import { kunLog } from '~/lib/log.server'
import {
  publishModerationHealth,
  readModerationHealth
} from '~/server/moderation/health'
import type { ModerationHealth } from '~/server/moderation/health'

const closed = {
  state: 'closed' as const,
  reason: null,
  since: null,
  openUntil: null,
  opens: 0,
  lastError: ''
}

const health: ModerationHealth = {
  at: 1_763_640_000_000,
  lanes: {
    text: {
      state: 'open',
      reason: 'dependency',
      since: 1_763_639_990_000,
      openUntil: 1_763_640_020_000,
      opens: 1,
      lastError: 'Moderation AI request failed with status 503'
    },
    avatar: closed
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('审核车道状态的上报与读取', () => {
  it('写与读是同一个键、同一种形状', async () => {
    const store = new Map<string, string>()
    setKvMock.mockImplementation(async (key: string, value: string) => {
      store.set(key, value)
    })
    getKvMock.mockImplementation(async (key: string) => store.get(key) ?? null)

    await publishModerationHealth(health)

    expect(setKvMock).toHaveBeenCalledWith(
      KUN_MODERATION_HEALTH_KEY,
      expect.any(String),
      120
    )
    expect(await readModerationHealth()).toEqual(health)
  })

  it('上报失败只记日志, 不往外抛', async () => {
    const error = new Error('redis down')
    setKvMock.mockRejectedValue(error)

    await expect(publishModerationHealth(health)).resolves.toBeUndefined()

    expect(kunLog).toHaveBeenCalledTimes(1)
    expect(kunLog).toHaveBeenCalledWith(
      'moderation.health_publish_failed',
      {},
      error
    )
  })

  it.each([
    ['键已过期', null],
    ['不是 JSON', 'not-json'],
    ['形状对不上 (新旧版本交替)', JSON.stringify({ at: 1, lanes: {} })],
    [
      '状态取值不认识',
      JSON.stringify({
        ...health,
        lanes: { ...health.lanes, avatar: { ...closed, state: 'broken' } }
      })
    ]
  ])('%s: 读作 null', async (_name, stored) => {
    getKvMock.mockResolvedValue(stored)

    expect(await readModerationHealth()).toBeNull()
  })

  it('Redis 读不到: 同样是 null, 不让统计接口失败', async () => {
    getKvMock.mockRejectedValue(new Error('redis down'))

    expect(await readModerationHealth()).toBeNull()
  })
})
