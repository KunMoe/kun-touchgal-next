import { beforeEach, describe, expect, it } from 'vitest'
import { createLaneBreaker } from '~/server/moderation/breaker'
import type {
  BreakerEvent,
  BreakerFailure,
  LaneBreakerOptions
} from '~/server/moderation/breaker'

let clock = 0
let events: BreakerEvent[] = []

const make = (overrides: Partial<LaneBreakerOptions> = {}) =>
  createLaneBreaker({
    dependencyThreshold: 3,
    minDistinctTasks: 2,
    systematicThreshold: 5,
    systematic: 'enforce',
    baseOpenMs: 30_000,
    maxOpenMs: 300_000,
    probeLeaseMs: 1_200_000,
    now: () => clock,
    onEvent: (event) => events.push(event),
    ...overrides
  })

const failure = (
  scope: BreakerFailure['scope'],
  taskId: number,
  retryAfterMs?: number
): BreakerFailure => ({
  scope,
  taskId,
  message: `${scope} #${taskId}`,
  retryAfterMs
})

// 探测名额的持有者回报的失败
const probeFailure = (
  scope: BreakerFailure['scope'],
  taskId: number,
  retryAfterMs?: number
): BreakerFailure => ({ ...failure(scope, taskId, retryAfterMs), probe: true })

beforeEach(() => {
  clock = 1_000_000
  events = []
})

describe('依赖类失败', () => {
  it('连续 3 次且跨 2 条不同任务才打开', () => {
    const breaker = make()

    expect(breaker.recordFailure(failure('transient', 1)).after.state).toBe(
      'closed'
    )
    expect(breaker.recordFailure(failure('transient', 2)).after.state).toBe(
      'closed'
    )
    const third = breaker.recordFailure(failure('transient', 1))

    expect(third.before).toBe('closed')
    expect(third.after).toEqual({
      state: 'open',
      reason: 'dependency',
      since: clock,
      openUntil: clock + 30_000,
      opens: 1,
      lastError: 'transient #1'
    })
  })

  it('同一条任务反复失败说明不了依赖: 多少次都不打开', () => {
    const breaker = make()

    for (let i = 0; i < 10; i++) {
      breaker.recordFailure(failure('transient', 1))
    }

    expect(breaker.snapshot().state).toBe('closed')
    // 换一条任务再失败一次, 两个条件同时满足
    expect(breaker.recordFailure(failure('transient', 2)).after.state).toBe(
      'open'
    )
  })

  it('中间有一次成功就从头数', () => {
    const breaker = make()

    breaker.recordFailure(failure('transient', 1))
    breaker.recordFailure(failure('transient', 2))
    breaker.recordSuccess()
    breaker.recordFailure(failure('transient', 3))
    breaker.recordFailure(failure('transient', 4))

    expect(breaker.snapshot().state).toBe('closed')
  })

  // 「连续」是指中间没有成功: 内容自身的失败不打断它
  it('中间夹着内容自身的失败不从头数', () => {
    const breaker = make()

    breaker.recordFailure(failure('transient', 1))
    breaker.recordFailure(failure('request', 5))
    breaker.recordFailure(failure('transient', 2))
    breaker.recordFailure(failure('internal', 6))

    expect(breaker.recordFailure(failure('transient', 3)).after.state).toBe(
      'open'
    )
  })

  it('触发打开的那次失败带着 Retry-After: 打开时长不短于它', () => {
    const breaker = make()

    breaker.recordFailure(failure('transient', 1))
    breaker.recordFailure(failure('transient', 2))
    const third = breaker.recordFailure(failure('transient', 3, 240_000))

    expect(third.after).toMatchObject({
      state: 'open',
      reason: 'dependency',
      openUntil: clock + 240_000
    })
  })

  it('没带 Retry-After 的 429 与超时、5xx 一起计数', () => {
    const breaker = make()

    breaker.recordFailure(failure('transient', 1))
    breaker.recordFailure(failure('rate_limited', 2))
    const third = breaker.recordFailure(failure('rate_limited', 3))

    expect(third.after).toMatchObject({ state: 'open', reason: 'rate_limited' })
  })
})

describe('依赖明说了原因', () => {
  it('凭据或地址不对: 第一次就打开', () => {
    const breaker = make()

    const record = breaker.recordFailure(failure('misconfigured', 1))

    expect(record.before).toBe('closed')
    expect(record.after).toMatchObject({
      state: 'open',
      reason: 'misconfigured',
      openUntil: clock + 30_000
    })
  })

  it('带 Retry-After 的 429: 第一次就打开, 至少等到它给的时刻', () => {
    const breaker = make()

    const record = breaker.recordFailure(failure('rate_limited', 1, 90_000))

    expect(record.after).toMatchObject({
      state: 'open',
      reason: 'rate_limited',
      openUntil: clock + 90_000
    })
  })

  it('Retry-After 为 0 等于没说: 不单凭这一次打开', () => {
    const breaker = make()

    expect(
      breaker.recordFailure(failure('rate_limited', 1, 0)).after.state
    ).toBe('closed')
  })

  it('Retry-After 比退避短时按退避, 超过上限时按上限', () => {
    expect(
      make().recordFailure(failure('rate_limited', 1, 5_000)).after.openUntil
    ).toBe(clock + 30_000)
    expect(
      make().recordFailure(failure('rate_limited', 1, 86_400_000)).after
        .openUntil
    ).toBe(clock + 300_000)
  })
})

describe('打开之后', () => {
  it('到点之前挡住, 到点后只放一条去探测', () => {
    const breaker = make()
    expect(breaker.admit()).toBe('pass')
    breaker.recordFailure(failure('misconfigured', 1))

    expect(breaker.admit()).toBe('blocked')
    clock += 29_999
    expect(breaker.admit()).toBe('blocked')
    clock += 1
    expect(breaker.admit()).toBe('probe')
    expect(breaker.snapshot().state).toBe('half_open')
    expect(breaker.admit()).toBe('blocked')
  })

  it('在途调用晚到的失败不改变状态, 也不延长打开时间', () => {
    const breaker = make()
    breaker.recordFailure(failure('misconfigured', 1))
    const opened = breaker.snapshot()
    clock += 10_000

    const late = breaker.recordFailure(failure('transient', 2, 600_000))

    expect(late.before).toBe('open')
    expect(late.after).toEqual({ ...opened, lastError: 'transient #2' })
  })

  it('探测成功: 回到 closed, 计数清零, 下一轮从最短时长开始', () => {
    const breaker = make()
    breaker.recordFailure(failure('misconfigured', 1))
    clock += 30_000
    breaker.admit()
    breaker.recordFailure(probeFailure('misconfigured', 1))
    clock += 60_000
    breaker.admit()

    breaker.recordSuccess()

    expect(breaker.snapshot()).toEqual({
      state: 'closed',
      reason: null,
      since: null,
      openUntil: null,
      opens: 0,
      lastError: ''
    })
    expect(breaker.admit()).toBe('pass')
    expect(
      breaker.recordFailure(failure('misconfigured', 2)).after
    ).toMatchObject({ opens: 1, openUntil: clock + 30_000 })
  })

  it('探测失败: 重新打开, 时长逐次翻倍到上限, 原因与起始时刻不变', () => {
    const breaker = make()
    const startedAt = clock
    breaker.recordFailure(failure('misconfigured', 1))

    const durations: number[] = []
    for (let i = 0; i < 6; i++) {
      clock = breaker.snapshot().openUntil!
      expect(breaker.admit()).toBe('probe')
      // 探测时撞上的是另一种依赖类失败: 这一轮的原因仍是最初打开它的那个
      const record = breaker.recordFailure(probeFailure('transient', 2))
      expect(record.before).toBe('half_open')
      expect(record.after).toMatchObject({
        state: 'open',
        reason: 'misconfigured',
        since: startedAt
      })
      durations.push(record.after.openUntil! - clock)
    }

    expect(durations).toEqual([
      60_000, 120_000, 240_000, 300_000, 300_000, 300_000
    ])
  })

  it('探测失败带 Retry-After 时同样不早于它', () => {
    const breaker = make()
    breaker.recordFailure(failure('misconfigured', 1))
    clock += 30_000
    breaker.admit()

    const record = breaker.recordFailure(
      probeFailure('rate_limited', 2, 200_000)
    )

    expect(record.after.openUntil).toBe(clock + 200_000)
  })

  // 打开之前就发出的调用可以拖到 half_open 才返回 (同一批里别的任务已经去探测了):
  // 它说明不了依赖现在的状态, 不能顶替探测的结果
  it('探测期间在途调用晚到的失败不算探测失败: 状态不变, 名额仍被占着', () => {
    const breaker = make()
    breaker.recordFailure(failure('misconfigured', 1))
    clock += 30_000
    expect(breaker.admit()).toBe('probe')
    const probing = breaker.snapshot()

    const late = breaker.recordFailure(failure('transient', 9))

    expect(late.before).toBe('half_open')
    expect(late.after).toEqual({ ...probing, lastError: 'transient #9' })
    expect(breaker.admit()).toBe('blocked')
  })

  // 探测拿到了依赖的应答, 只是这条内容自己处理不成: 依赖故障已经过去
  it.each(['request', 'internal'] as const)(
    '探测撞上内容自身的失败 (%s): 车道闭合, 这次失败只进系统性故障的计数',
    (scope) => {
      const breaker = make()
      breaker.recordFailure(failure('transient', 1))
      breaker.recordFailure(failure('transient', 2))
      breaker.recordFailure(failure('transient', 3))
      clock += 30_000
      breaker.admit()

      const record = breaker.recordFailure(probeFailure(scope, 7))

      expect(record.before).toBe('half_open')
      expect(record.after).toEqual({
        state: 'closed',
        reason: null,
        since: null,
        openUntil: null,
        opens: 0,
        lastError: `${scope} #7`
      })
      expect(breaker.admit()).toBe('pass')
      // 依赖类的计数已清零: 再来两次不足以打开
      breaker.recordFailure(failure('transient', 1))
      breaker.recordFailure(failure('transient', 2))
      expect(breaker.snapshot().state).toBe('closed')
      // 这次失败算作系统性故障的第一条: 再来 4 条不同任务才打开
      for (let i = 10; i < 13; i++) {
        breaker.recordFailure(failure('request', i))
      }
      expect(breaker.snapshot().state).toBe('closed')
      expect(breaker.recordFailure(failure('request', 13)).after).toMatchObject(
        { state: 'open', reason: 'systematic' }
      )
    }
  )

  it('车道是因系统性故障打开的: 探测撞上内容自身的失败说明故障还在, 重新打开', () => {
    const breaker = make()
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(failure('request', i))
    }
    clock += 30_000
    breaker.admit()

    const record = breaker.recordFailure(probeFailure('request', 0))

    expect(record.after).toMatchObject({
      state: 'open',
      reason: 'systematic',
      opens: 2,
      openUntil: clock + 60_000
    })
  })

  it('打开期间在途调用成功了也算成功', () => {
    const breaker = make()
    breaker.recordFailure(failure('misconfigured', 1))

    breaker.recordSuccess()

    expect(breaker.admit()).toBe('pass')
  })
})

describe('探测名额', () => {
  const halfOpen = (overrides: Partial<LaneBreakerOptions> = {}) => {
    const breaker = make(overrides)
    breaker.recordFailure(failure('misconfigured', 1))
    clock += 30_000
    return breaker
  }

  // 拿了名额却没调到依赖 (没有可认领的任务、命中缓存) 时不归还, 车道就永远停在
  // half_open: 再没有人能去探测
  it('归还之后下一个调用方可以再拿', () => {
    const breaker = halfOpen()
    expect(breaker.admit()).toBe('probe')
    expect(breaker.admit()).toBe('blocked')

    breaker.releaseProbe()

    expect(breaker.admit()).toBe('probe')
    expect(breaker.snapshot().state).toBe('half_open')
  })

  it('拿了名额的调用方始终没有回报: 占用期满自动归还', () => {
    const breaker = halfOpen({ probeLeaseMs: 600_000 })
    expect(breaker.admit()).toBe('probe')

    clock += 599_999
    expect(breaker.admit()).toBe('blocked')
    clock += 1
    expect(breaker.admit()).toBe('probe')
  })
})

describe('系统性故障', () => {
  it('没有任何成功, 5 条不同任务都以 request / internal 失败: 打开', () => {
    const breaker = make()

    for (const [index, scope] of (
      ['request', 'internal', 'request', 'request'] as const
    ).entries()) {
      expect(breaker.recordFailure(failure(scope, index)).after.state).toBe(
        'closed'
      )
    }
    const fifth = breaker.recordFailure(failure('request', 4))

    expect(fifth.before).toBe('closed')
    expect(fifth.after).toMatchObject({
      state: 'open',
      reason: 'systematic',
      openUntil: clock + 30_000
    })
  })

  it('同一条任务重试多少次都只算一条', () => {
    const breaker = make()

    for (let i = 0; i < 20; i++) {
      breaker.recordFailure(failure('request', i % 4))
    }

    expect(breaker.snapshot().state).toBe('closed')
  })

  it('中间有一次成功就从头数', () => {
    const breaker = make()

    for (let i = 0; i < 4; i++) {
      breaker.recordFailure(failure('request', i))
    }
    breaker.recordSuccess()
    for (let i = 4; i < 8; i++) {
      breaker.recordFailure(failure('request', i))
    }

    expect(breaker.snapshot().state).toBe('closed')
  })

  it("systematic: 'log' 时只报一次疑似, 不打开", () => {
    const breaker = make({ systematic: 'log' })

    for (let i = 0; i < 12; i++) {
      breaker.recordFailure(failure('request', i))
    }

    expect(breaker.snapshot().state).toBe('closed')
    expect(events).toEqual([
      { type: 'systematic_suspected', tasks: 5, lastError: 'request #4' }
    ])

    // 成功之后是新的一轮, 再出现时再报
    breaker.recordSuccess()
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure(failure('internal', i))
    }
    expect(events).toHaveLength(2)
  })

  it('依赖类失败不计入系统性故障, 反之亦然', () => {
    const breaker = make()

    for (let i = 0; i < 4; i++) {
      breaker.recordFailure(failure('request', i))
    }
    breaker.recordFailure(failure('transient', 10))
    breaker.recordFailure(failure('transient', 11))

    expect(breaker.snapshot().state).toBe('closed')
  })
})

describe('状态迁移事件', () => {
  it('每次迁移报一条; 回到 closed 的那条带着刚结束的这一轮', () => {
    const breaker = make()
    const startedAt = clock

    breaker.recordFailure(failure('misconfigured', 1))
    clock += 30_000
    breaker.admit()
    breaker.recordFailure(probeFailure('misconfigured', 1))
    clock += 60_000
    breaker.admit()
    breaker.recordSuccess()
    // closed 上的成功不是迁移
    breaker.recordSuccess()

    expect(events).toEqual([
      {
        type: 'transition',
        from: 'closed',
        to: 'open',
        reason: 'misconfigured',
        since: startedAt,
        openUntil: startedAt + 30_000,
        opens: 1,
        lastError: 'misconfigured #1'
      },
      {
        type: 'transition',
        from: 'open',
        to: 'half_open',
        reason: 'misconfigured',
        since: startedAt,
        openUntil: startedAt + 30_000,
        opens: 1,
        lastError: 'misconfigured #1'
      },
      {
        type: 'transition',
        from: 'half_open',
        to: 'open',
        reason: 'misconfigured',
        since: startedAt,
        openUntil: startedAt + 90_000,
        opens: 2,
        lastError: 'misconfigured #1'
      },
      {
        type: 'transition',
        from: 'open',
        to: 'half_open',
        reason: 'misconfigured',
        since: startedAt,
        openUntil: startedAt + 90_000,
        opens: 2,
        lastError: 'misconfigured #1'
      },
      {
        type: 'transition',
        from: 'half_open',
        to: 'closed',
        reason: 'misconfigured',
        since: startedAt,
        openUntil: startedAt + 90_000,
        opens: 2,
        lastError: 'misconfigured #1'
      }
    ])
  })

  it('错误原文过长时截断', () => {
    const breaker = make()

    breaker.recordFailure({
      scope: 'misconfigured',
      taskId: 1,
      message: '长'.repeat(500)
    })

    expect(breaker.snapshot().lastError).toBe('长'.repeat(200))
  })
})
