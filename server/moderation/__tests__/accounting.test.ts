import { describe, expect, it } from 'vitest'
import {
  MODERATION_BATCH_SIZE,
  MODERATION_BREAKER,
  MODERATION_MAX_DEFERRALS
} from '~/constants/moderation'
import { DependencyFailure } from '~/lib/resilience/failure'
import {
  decideFailureAccounting,
  decideLegacyAccounting
} from '~/server/moderation/accounting'
import { createLaneBreaker } from '~/server/moderation/breaker'
import type {
  BreakerRecord,
  BreakerState,
  TaskFailureScope
} from '~/server/moderation/breaker'

const NOW = 1_000_000

const record = (
  before: BreakerState,
  after: { state: BreakerState; openUntil?: number | null } = { state: before }
): BreakerRecord => ({
  before,
  after: {
    state: after.state,
    reason: after.state === 'closed' ? null : 'dependency',
    since: after.state === 'closed' ? null : NOW,
    openUntil: after.openUntil ?? null,
    opens: after.state === 'closed' ? 0 : 1,
    lastError: 'x'
  }
})

const decide = (
  overrides: Partial<Parameters<typeof decideFailureAccounting>[0]> = {}
) =>
  decideFailureAccounting({
    task: { retry: 0, defer_count: 0 },
    scope: 'transient',
    message: 'upstream 503',
    retryAfterMs: null,
    record: record('closed'),
    now: NOW,
    ...overrides
  })

describe('车道当时已经不是 closed: 不扣任何预算', () => {
  it.each([
    ['open', 'transient'],
    ['open', 'request'],
    ['half_open', 'misconfigured'],
    ['half_open', 'internal']
  ] as const)('%s 时的 %s 失败推迟到下一次探测', (before, scope) => {
    const decision = decide({
      task: { retry: 2, defer_count: 5 },
      scope,
      record: record(before, { state: 'open', openUntil: NOW + 45_000 })
    })

    expect(decision).toMatchObject({
      action: 'defer',
      nextAttempt: new Date(NOW + 45_000)
    })
    expect(decision).not.toHaveProperty('deferCount')
    expect(decision).not.toHaveProperty('retry')
  })

  it('探测时刻已过 (在途调用回来得晚): 立即可再试', () => {
    expect(
      decide({
        record: record('open', { state: 'open', openUntil: NOW - 1 })
      })
    ).toMatchObject({ action: 'defer', nextAttempt: new Date(NOW) })
  })
})

describe('车道是 closed, 依赖类失败: 扣推迟预算', () => {
  it.each([
    ['transient', 'unavailable'],
    ['rate_limited', 'rate_limited'],
    ['misconfigured', 'misconfigured']
  ] as const)('%s → defer_count 加一, 类别 %s, retry 不动', (scope, kind) => {
    const decision = decide({ scope, task: { retry: 2, defer_count: 0 } })

    expect(decision).toEqual({
      action: 'defer',
      nextAttempt: new Date(NOW + 60_000),
      deferCount: 1,
      kind
    })
  })

  it('退避 60 秒起逐次翻倍, 封顶 10 分钟', () => {
    const delays = [0, 1, 2, 3, 4].map((deferCount) => {
      const decision = decide({ task: { retry: 0, defer_count: deferCount } })
      return decision.action === 'defer'
        ? decision.nextAttempt.getTime() - NOW
        : null
    })

    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 600_000])
  })

  it('第 6 次失败转人工: 这是「超时止损」的次数上界', () => {
    expect(MODERATION_MAX_DEFERRALS).toBe(6)
    expect(
      decide({ task: { retry: 0, defer_count: 5 }, message: 'timeout' })
    ).toEqual({
      action: 'manual',
      kind: 'deferral_exhausted',
      reason: '依赖类失败已推迟 5 次仍未成功: timeout'
    })
  })

  it('不早于依赖给的 Retry-After, 但它说得再久也只等 10 分钟', () => {
    expect(decide({ retryAfterMs: 90_000 })).toMatchObject({
      nextAttempt: new Date(NOW + 90_000)
    })
    expect(decide({ retryAfterMs: 5_000 })).toMatchObject({
      nextAttempt: new Date(NOW + 60_000)
    })
    expect(decide({ retryAfterMs: 86_400_000 })).toMatchObject({
      nextAttempt: new Date(NOW + 600_000)
    })
  })

  it('这次失败把车道打开了: 照样扣预算, 且不早于车道的下一次探测', () => {
    expect(
      decide({
        scope: 'misconfigured',
        record: record('closed', { state: 'open', openUntil: NOW + 300_000 })
      })
    ).toEqual({
      action: 'defer',
      nextAttempt: new Date(NOW + 300_000),
      deferCount: 1,
      kind: 'misconfigured'
    })
  })
})

describe('车道是 closed, 这条内容自己的失败: 扣重试预算', () => {
  it.each([
    ['request', 'bad_output'],
    ['internal', 'internal']
  ] as const)('%s → retry 加一, 类别 %s, defer_count 不动', (scope, kind) => {
    expect(decide({ scope, task: { retry: 0, defer_count: 5 } })).toEqual({
      action: 'retry',
      nextAttempt: new Date(NOW + 5_000),
      retry: 1,
      kind
    })
  })

  it('第二次 25 秒后再试, 第三次转人工', () => {
    expect(
      decide({ scope: 'request', task: { retry: 1, defer_count: 0 } })
    ).toMatchObject({ retry: 2, nextAttempt: new Date(NOW + 25_000) })
    expect(
      decide({
        scope: 'request',
        task: { retry: 2, defer_count: 0 },
        message: 'not valid JSON'
      })
    ).toEqual({
      action: 'manual',
      kind: 'bad_output',
      reason: '审核失败: not valid JSON'
    })
  })

  it('这次失败触发了系统性故障: 不早于车道的下一次探测', () => {
    expect(
      decide({
        scope: 'request',
        record: record('closed', { state: 'open', openUntil: NOW + 30_000 })
      })
    ).toMatchObject({
      action: 'retry',
      retry: 1,
      nextAttempt: new Date(NOW + 30_000)
    })
  })
})

// 影子模式沿用的旧记账: 与引入车道之前逐条相同
describe('decideLegacyAccounting', () => {
  const legacy = (retry: number, error: unknown, scope: TaskFailureScope) =>
    decideLegacyAccounting({ task: { retry }, error, scope, now: NOW })

  it('每次失败都扣这条任务的 retry, 不看失败的范围', () => {
    const outage = new DependencyFailure({
      dependency: 'moderation_ai',
      scope: 'transient',
      message: 'status 503',
      status: 503
    })

    expect(legacy(0, outage, 'transient')).toEqual({
      action: 'retry',
      nextAttempt: new Date(NOW + 5_000),
      retry: 1,
      kind: 'unavailable'
    })
    expect(legacy(1, outage, 'transient')).toMatchObject({
      retry: 2,
      nextAttempt: new Date(NOW + 25_000)
    })
    expect(legacy(2, outage, 'transient')).toEqual({
      action: 'manual',
      kind: 'unavailable',
      reason: '审核失败: status 503'
    })
  })

  it('没带范围的错误: 原因里带上它的类名, 与改动前相同', () => {
    expect(legacy(2, new TypeError('x is not a function'), 'internal')).toEqual(
      {
        action: 'manual',
        kind: 'internal',
        reason: '审核失败: TypeError: x is not a function'
      }
    )
  })

  it('模型的地址或密钥没配: 不重试, 直接转人工', () => {
    const missing = new DependencyFailure({
      dependency: 'moderation_ai',
      scope: 'misconfigured',
      message:
        'MODERATION_AI_BASE_URL or MODERATION_AI_API_KEY is not configured'
    })

    expect(legacy(0, missing, 'misconfigured')).toEqual({
      action: 'manual',
      kind: 'misconfigured',
      reason:
        'MODERATION_AI_BASE_URL or MODERATION_AI_API_KEY is not configured'
    })
  })

  it('依赖回的 401 不是「没配」: 照常重试', () => {
    const unauthorized = new DependencyFailure({
      dependency: 'moderation_ai',
      scope: 'misconfigured',
      message: 'status 401',
      status: 401
    })

    expect(legacy(0, unauthorized, 'misconfigured')).toMatchObject({
      action: 'retry',
      retry: 1
    })
  })
})

// 归因规则只有放进队列里跑才看得出好坏: 用真实的熔断器与记账函数模拟 worker 的节拍
// (每 15 秒一拍、每拍一批), 对照裁决时的探针场景。失败的范围由场景直接给出。
// 这里验的是「熔断器 × 记账」合起来的走向, 一批内是顺序处理的; worker 自己的并发、
// 取任务与分组在 server/tasks/__tests__/moderationBatch.test.ts
describe('场景: 队列在各种故障下的走向', () => {
  const TICK_MS = 15_000

  interface SimTask {
    id: number
    poison: boolean
    createdAt: number
    nextAttempt: number
    retry: number
    defer_count: number
    status: 'pending' | 'done' | 'manual'
    doneAt?: number
    kind?: string
  }

  const simulate = (
    outcomeOf: (task: SimTask, at: number) => TaskFailureScope | 'ok',
    {
      arrivalsPerMin = 4,
      horizonMin = 180,
      poison = false,
      systematic = 'enforce' as 'log' | 'enforce'
    } = {}
  ) => {
    let at = 0
    let opens = 0
    let modelCalls = 0
    const breaker = createLaneBreaker({
      ...MODERATION_BREAKER,
      systematic,
      probeLeaseMs: 1_200_000,
      now: () => at,
      onEvent: (event) => {
        if (event.type === 'transition' && event.from === 'closed') {
          opens++
        }
      }
    })
    const tasks: SimTask[] = []
    const add = (isPoison: boolean) =>
      tasks.push({
        id: tasks.length,
        poison: isPoison,
        createdAt: at,
        nextAttempt: at,
        retry: 0,
        defer_count: 0,
        status: 'pending'
      })
    if (poison) {
      add(true)
    }

    let arrivalDebt = 0
    for (; at <= horizonMin * 60_000; at += TICK_MS) {
      arrivalDebt += (arrivalsPerMin * TICK_MS) / 60_000
      for (; arrivalDebt >= 1; arrivalDebt--) {
        add(false)
      }

      const admission = breaker.admit()
      if (admission === 'blocked') {
        continue
      }
      const batch = tasks
        .filter((task) => task.status === 'pending' && task.nextAttempt <= at)
        .sort((a, b) => a.nextAttempt - b.nextAttempt)
        .slice(0, admission === 'probe' ? 1 : MODERATION_BATCH_SIZE)
      if (admission === 'probe' && !batch.length) {
        breaker.releaseProbe()
        continue
      }
      for (const [index, task] of batch.entries()) {
        // 认领之前再问一次门; 探测的那一条已经拿着名额
        if (
          !(admission === 'probe' && index === 0) &&
          breaker.admit() !== 'pass'
        ) {
          break
        }
        modelCalls++
        const outcome = outcomeOf(task, at)
        if (outcome === 'ok') {
          task.status = 'done'
          task.doneAt = at
          breaker.recordSuccess()
          continue
        }
        const decision = decideFailureAccounting({
          task,
          scope: outcome,
          message: outcome,
          retryAfterMs: null,
          record: breaker.recordFailure({
            scope: outcome,
            taskId: task.id,
            message: outcome,
            probe: admission === 'probe' && index === 0
          }),
          now: at
        })
        if (decision.action === 'manual') {
          task.status = 'manual'
          task.kind = decision.kind
          continue
        }
        task.nextAttempt = decision.nextAttempt.getTime()
        if (decision.action === 'retry') {
          task.retry = decision.retry
        } else if (decision.deferCount !== undefined) {
          task.defer_count = decision.deferCount
        }
      }
    }

    const healthy = tasks.filter((task) => !task.poison)
    const latencies = healthy
      .filter((task) => task.status === 'done')
      .map((task) => task.doneAt! - task.createdAt)
      .sort((a, b) => a - b)
    const manual = tasks.filter((task) => task.status === 'manual')
    return {
      healthyTotal: healthy.length,
      healthyDone: healthy.filter((task) => task.status === 'done').length,
      healthyPending: healthy.filter((task) => task.status === 'pending')
        .length,
      manual: manual.length,
      manualKinds: [...new Set(manual.map((task) => task.kind))],
      poisonTask: tasks.find((task) => task.poison),
      opens,
      modelCalls,
      p50Ms: latencies[Math.floor(latencies.length / 2)],
      p95Ms: latencies[Math.floor(latencies.length * 0.95)]
    }
  }

  // 第 10 到第 70 分钟出故障
  const during = (at: number) => at >= 10 * 60_000 && at < 70 * 60_000

  it('S1 供应商 503 宕机 60 分钟: 没有一条转人工, 恢复后全部自动处理完', () => {
    const result = simulate((_task, at) => (during(at) ? 'transient' : 'ok'))

    expect(result).toMatchObject({
      manual: 0,
      healthyPending: 0,
      healthyDone: result.healthyTotal,
      opens: 1
    })
    // 故障期间只有探测在调用供应商 (不设车道时是每条任务三次)
    expect(result.modelCalls).toBeLessThan(result.healthyTotal + 30)
  })

  it('S2 密钥失效 (401) 60 分钟: 同样没有一条转人工', () => {
    const result = simulate((_task, at) =>
      during(at) ? 'misconfigured' : 'ok'
    )

    expect(result).toMatchObject({
      manual: 0,
      healthyPending: 0,
      healthyDone: result.healthyTotal,
      opens: 1
    })
  })

  it('S3 只有一条内容被网关 403: 它在推迟预算内转人工, 正常任务不受拖累', () => {
    const result = simulate((task) => (task.poison ? 'misconfigured' : 'ok'), {
      poison: true
    })

    expect(result.poisonTask).toMatchObject({
      status: 'manual',
      kind: 'deferral_exhausted',
      retry: 0,
      defer_count: MODERATION_MAX_DEFERRALS - 1
    })
    // 它每试一次打开一次车道, 试满就停; 不计预算的话三小时里会打开两百多次
    expect(result.opens).toBe(MODERATION_MAX_DEFERRALS)
    expect(result).toMatchObject({
      manual: 1,
      healthyPending: 0,
      p50Ms: 0,
      p95Ms: 0
    })
  })

  it('S4 低流量下只有那一条毒内容: 没有成功来复位, 它停在 pending 由探测慢速重试', () => {
    const result = simulate((task) => (task.poison ? 'misconfigured' : 'ok'), {
      poison: true,
      arrivalsPerMin: 0,
      horizonMin: 360
    })

    // 这是已知的代价 (管理端的车道状态上可见): 有界的调用量, 不转人工
    expect(result.poisonTask).toMatchObject({
      status: 'pending',
      defer_count: 1
    })
    expect(result.modelCalls).toBeLessThan(90)
  })

  it('S5 只有一条内容每次都超时: 车道不打开, 它试满 6 次转人工', () => {
    const result = simulate((task) => (task.poison ? 'transient' : 'ok'), {
      poison: true
    })

    expect(result.poisonTask).toMatchObject({
      status: 'manual',
      kind: 'deferral_exhausted'
    })
    expect(result).toMatchObject({ manual: 1, opens: 0, p95Ms: 0 })
  })

  it('S6 供应商随机 30% 失败 3 小时: 没有一条转人工', () => {
    let seed = 42
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }

    const result = simulate(() => (random() < 0.3 ? 'transient' : 'ok'))

    expect(result.manual).toBe(0)
    // 末尾几条还在退避里, 其余都处理完了
    expect(result.healthyPending).toBeLessThan(10)
  })

  it('S7 模型输出系统性损坏 60 分钟: 车道打开, 只有最先撞上的几条转人工', () => {
    const result = simulate((_task, at) => (during(at) ? 'request' : 'ok'))

    expect(result.manual).toBeLessThanOrEqual(3)
    expect(result).toMatchObject({ healthyPending: 0, opens: 1 })
  })

  it('S7 对照: 系统性检测只记日志时, 故障期间到达的每一条都转人工', () => {
    const result = simulate((_task, at) => (during(at) ? 'request' : 'ok'), {
      systematic: 'log'
    })

    expect(result.manual).toBeGreaterThan(200)
    expect(result.opens).toBe(0)
  })

  it('S8 只有一条内容的输出确定性损坏: 三次后转人工, 车道不打开', () => {
    const result = simulate((task) => (task.poison ? 'request' : 'ok'), {
      poison: true
    })

    expect(result.poisonTask).toMatchObject({
      status: 'manual',
      kind: 'bad_output',
      retry: 2
    })
    expect(result).toMatchObject({ manual: 1, opens: 0, p95Ms: 0 })
  })
})
