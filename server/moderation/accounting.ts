import {
  MODERATION_MAX_DEFERRALS,
  MODERATION_MAX_RETRY
} from '~/constants/moderation'
import type { ModerationFailureKind } from '~/constants/moderation'
import { DependencyFailure } from '~/lib/resilience/failure'
import type { BreakerRecord, TaskFailureScope } from './breaker'

// 审核任务的失败记账: 一次失败算在谁头上、之后怎么办, 全在这一个纯函数里定。
//
// 失败有三种来源: 依赖整体不可用, 配置错误, 以及这一条内容自己确定性的失败。前两种对
// 所有任务同时成立, 不该扣内容的预算; 但只凭一次失败的范围 (scope) 分不出来 —— 一条
// 稳定打崩上游的内容, 每次失败看上去都是依赖的问题。所以归因看车道在「记录这次失败
// 之前」的状态:
//
// 1. 车道当时已经不是 closed (打开之后才返回的在途调用、探测失败): 这次失败没有带来
//    新信息, 推迟到车道的下一次探测, 什么预算都不扣;
// 2. 车道当时是 closed, 失败属依赖类 (含把车道打开的那一次): 扣推迟预算 defer_count。
//    必须扣: 能立即打开车道的失败 (例如只有这条内容被网关 403) 若不计数, 这条内容会
//    一直不消耗预算、反复把整条车道打开;
// 3. 车道当时是 closed, 失败属这条内容自己 (request / internal): 扣重试预算 retry。
//
// 认不出的错误一律是 internal, 落在第 3 条: 分类错了最坏只是退回到「每次失败都扣这条
// 任务」

export type FailureAccounting =
  | {
      action: 'defer'
      nextAttempt: Date
      // 缺省 = 这次不扣推迟预算
      deferCount?: number
      kind: ModerationFailureKind
    }
  | {
      action: 'retry'
      nextAttempt: Date
      retry: number
      kind: ModerationFailureKind
    }
  | { action: 'manual'; kind: ModerationFailureKind; reason: string }

const KIND_OF_SCOPE: Record<TaskFailureScope, ModerationFailureKind> = {
  transient: 'unavailable',
  rate_limited: 'rate_limited',
  misconfigured: 'misconfigured',
  request: 'bad_output',
  internal: 'internal'
}

const isDependencyScope = (scope: TaskFailureScope) =>
  scope === 'transient' || scope === 'rate_limited' || scope === 'misconfigured'

// 推迟的退避: 60 秒起逐次翻倍, 最长 10 分钟。依赖给的 Retry-After 同样封顶在这里 ——
// 它说一天, 也不该让这条内容一天之后才再试 (车道自己会挡住过早的调用)
const DEFERRAL_BASE_MS = 30 * 1000
const DEFERRAL_MAX_MS = 10 * 60 * 1000

export const failureKindOf = (scope: TaskFailureScope) => KIND_OF_SCOPE[scope]

export const decideFailureAccounting = (input: {
  task: { retry: number; defer_count: number }
  scope: TaskFailureScope
  message: string
  retryAfterMs: number | null
  record: BreakerRecord
  now: number
}): FailureAccounting => {
  const { task, scope, message, retryAfterMs, record, now } = input
  const kind = KIND_OF_SCOPE[scope]
  // 车道不放行到什么时候; 闭合时为 0
  const openUntil = record.after.openUntil ?? 0

  if (record.before !== 'closed') {
    return {
      action: 'defer',
      nextAttempt: new Date(Math.max(openUntil, now)),
      kind
    }
  }

  if (isDependencyScope(scope)) {
    const deferCount = task.defer_count + 1
    if (deferCount >= MODERATION_MAX_DEFERRALS) {
      return {
        action: 'manual',
        kind: 'deferral_exhausted',
        reason: `依赖类失败已推迟 ${deferCount - 1} 次仍未成功: ${message}`
      }
    }
    const backoff = Math.min(
      DEFERRAL_BASE_MS * 2 ** deferCount,
      DEFERRAL_MAX_MS
    )
    const retryAfter = Math.min(retryAfterMs ?? 0, DEFERRAL_MAX_MS)
    return {
      action: 'defer',
      nextAttempt: new Date(
        Math.max(now + backoff, now + retryAfter, openUntil)
      ),
      deferCount,
      kind
    }
  }

  const retry = task.retry + 1
  if (retry >= MODERATION_MAX_RETRY) {
    return { action: 'manual', kind, reason: `审核失败: ${message}` }
  }
  return {
    action: 'retry',
    // 5 秒、25 秒; 这次失败把车道打开了 (系统性故障) 时不早于它的下一次探测
    nextAttempt: new Date(Math.max(now + 5 ** retry * 1000, openUntil)),
    retry,
    kind
  }
}

// 影子模式 (MODERATION_BREAKER_MODE = 'shadow') 沿用的旧记账, 与引入车道之前逐条相同:
// 配置缺失直接转人工, 其余每次失败都扣这条任务的 retry, 第三次转人工。切到 'enforce'
// 并稳定之后, 这个函数连同 worker 里的调用点一起删
export const decideLegacyAccounting = (input: {
  task: { retry: number }
  error: unknown
  scope: TaskFailureScope
  now: number
}): FailureAccounting => {
  const { task, error, scope, now } = input
  const kind = KIND_OF_SCOPE[scope]

  // 没有状态码的 misconfigured 只有一种来源: 模型的地址或密钥没配
  if (
    error instanceof DependencyFailure &&
    error.scope === 'misconfigured' &&
    error.status === null
  ) {
    return { action: 'manual', kind, reason: error.message }
  }

  const retry = task.retry + 1
  if (retry >= MODERATION_MAX_RETRY) {
    return { action: 'manual', kind, reason: `审核失败: ${String(error)}` }
  }
  return {
    action: 'retry',
    nextAttempt: new Date(now + 5 ** retry * 1000),
    retry,
    kind
  }
}
