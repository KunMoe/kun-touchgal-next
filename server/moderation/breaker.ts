import type { FailureScope } from '~/lib/resilience/failure'

// 审核车道的熔断器: 纯状态机, 不碰库、Redis 与时钟以外的任何东西。
//
// 单看一条任务判断不出一次失败该算谁的: 同一个 503 可能是供应商宕机, 也可能是这条内容
// 打崩了上游网关。能区分两者的只有多条任务之间的相关性, 所以由车道 (一类任务共用的
// 那个依赖) 来观察: 失败跨了几条不同的任务、中间有没有任何一条成功。它只给出「车道
// 现在的状态」与「这次失败记录之前的状态」, 一次失败扣不扣任务自己的预算由
// accounting.ts 据此决定

export type BreakerState = 'closed' | 'open' | 'half_open'

// 进不到 provider 边界的失败 (渲染、落库、图片解码等) 没有 FailureScope
export type TaskFailureScope = FailureScope | 'internal'

// dependency: 依赖不可用 (超时、5xx、断流) 跨任务连续出现
// rate_limited / misconfigured: 依赖明说了原因
// systematic: 依赖答复正常, 但没有一条任务处理得成 (输出格式坏了、落库被拒)
export type BreakerReason =
  'dependency' | 'rate_limited' | 'misconfigured' | 'systematic'

export interface BreakerSnapshot {
  state: BreakerState
  reason: BreakerReason | null
  // 这一轮故障第一次打开的时刻; 回到 closed 时清空
  since: number | null
  // 最早的下一次探测时刻; closed 时为 null
  openUntil: number | null
  // 这一轮里连续打开了几次 (探测失败一次加一)
  opens: number
  lastError: string
}

export type BreakerEvent =
  // to 为 closed 时, 其余字段是刚结束的那一轮故障的
  | ({ type: 'transition'; from: BreakerState; to: BreakerState } & Omit<
      BreakerSnapshot,
      'state'
    >)
  // systematic 只观察不打开时, 每一轮报一次
  | { type: 'systematic_suspected'; tasks: number; lastError: string }

export interface LaneBreakerOptions {
  // 依赖类失败连续多少次、且覆盖多少条不同任务才打开: 单条任务反复失败说明不了依赖
  dependencyThreshold: number
  minDistinctTasks: number
  // 没有任何成功的前提下, 多少条不同任务以 request / internal 失败算系统性故障
  systematicThreshold: number
  // 'log': 只报 systematic_suspected, 不打开
  systematic: 'log' | 'enforce'
  // 打开时长 min(baseOpenMs × 2^(n-1), maxOpenMs), 且不短于封顶后的 Retry-After
  baseOpenMs: number
  maxOpenMs: number
  // 探测名额的最长占用时间: 拿了名额的调用方无论如何没有回报时, 到点自动归还,
  // 否则车道会永远停在 half_open
  probeLeaseMs: number
  now?: () => number
  onEvent?: (event: BreakerEvent) => void
}

export interface BreakerFailure {
  scope: TaskFailureScope
  taskId: number
  message: string
  retryAfterMs?: number | null
}

export interface BreakerRecord {
  // 记录这次失败之前的状态: 归因看它, 不看记录之后的
  before: BreakerState
  after: BreakerSnapshot
}

const LAST_ERROR_MAX_LENGTH = 200

export const createLaneBreaker = (options: LaneBreakerOptions) => {
  const { now = Date.now, onEvent } = options

  let state: BreakerState = 'closed'
  let reason: BreakerReason | null = null
  let since: number | null = null
  let openUntil = 0
  let opens = 0
  let probeStartedAt: number | null = null
  let dependencyStreak = 0
  let dependencyTasks = new Set<number>()
  let systematicTasks = new Set<number>()
  let systematicReported = false
  let lastError = ''

  const snapshot = (): BreakerSnapshot => ({
    state,
    reason,
    since,
    openUntil: state === 'closed' ? null : openUntil,
    opens,
    lastError
  })

  const moveTo = (to: BreakerState) => {
    const from = state
    state = to
    if (from !== to) {
      const { state: _state, ...rest } = snapshot()
      onEvent?.({ type: 'transition', from, to, ...rest })
    }
  }

  const open = (
    why: BreakerReason,
    retryAfterMs: number | null | undefined
  ) => {
    opens++
    reason = why
    since ??= now()
    const backoff = Math.min(
      options.baseOpenMs * 2 ** (opens - 1),
      options.maxOpenMs
    )
    openUntil =
      now() + Math.max(backoff, Math.min(retryAfterMs ?? 0, options.maxOpenMs))
    probeStartedAt = null
    moveTo('open')
  }

  return {
    // pass: 照常处理; probe: 只放这一条去探测, 调用方之后必须回报成功 / 失败或归还名额;
    // blocked: 不要调用依赖
    admit: (): 'pass' | 'probe' | 'blocked' => {
      if (state === 'closed') {
        return 'pass'
      }
      if (state === 'open') {
        if (now() < openUntil) {
          return 'blocked'
        }
        moveTo('half_open')
      }
      if (
        probeStartedAt !== null &&
        now() - probeStartedAt < options.probeLeaseMs
      ) {
        return 'blocked'
      }
      probeStartedAt = now()
      return 'probe'
    },

    // 拿到探测名额却没有调到依赖 (没有可认领的任务、命中缓存) 时归还
    releaseProbe: () => {
      probeStartedAt = null
    },

    // 任何一次成功都说明依赖可用、任务处理得成: 回到 closed 并清零全部计数
    recordSuccess: () => {
      const ended = snapshot()
      reason = null
      since = null
      openUntil = 0
      opens = 0
      probeStartedAt = null
      dependencyStreak = 0
      dependencyTasks = new Set()
      systematicTasks = new Set()
      systematicReported = false
      lastError = ''
      state = 'closed'
      if (ended.state !== 'closed') {
        const { state: from, ...rest } = ended
        onEvent?.({ type: 'transition', from, to: 'closed', ...rest })
      }
    },

    recordFailure: (failure: BreakerFailure): BreakerRecord => {
      const before = state
      const { scope, taskId, retryAfterMs } = failure
      lastError = failure.message.slice(0, LAST_ERROR_MAX_LENGTH)

      if (state === 'half_open') {
        // 探测失败: 重新打开, 时长翻倍
        open(reason ?? 'dependency', retryAfterMs)
      } else if (state === 'open') {
        // 打开之后才返回的在途调用, 不改变状态
      } else if (scope === 'misconfigured') {
        open('misconfigured', null)
      } else if (scope === 'rate_limited' && retryAfterMs != null) {
        open('rate_limited', retryAfterMs)
      } else if (scope === 'transient' || scope === 'rate_limited') {
        dependencyStreak++
        dependencyTasks.add(taskId)
        if (
          dependencyStreak >= options.dependencyThreshold &&
          dependencyTasks.size >= options.minDistinctTasks
        ) {
          open(scope === 'rate_limited' ? 'rate_limited' : 'dependency', null)
        }
      } else {
        systematicTasks.add(taskId)
        if (systematicTasks.size >= options.systematicThreshold) {
          if (options.systematic === 'enforce') {
            open('systematic', null)
          } else if (!systematicReported) {
            systematicReported = true
            onEvent?.({
              type: 'systematic_suspected',
              tasks: systematicTasks.size,
              lastError
            })
          }
        }
      }

      return { before, after: snapshot() }
    },

    snapshot
  }
}

export type LaneBreaker = ReturnType<typeof createLaneBreaker>
