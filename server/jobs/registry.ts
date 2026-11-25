import cron from 'node-cron'
import { claimJobSlot, withJobLease } from './lease'

// 进程内的最小作业层: 定时任务只声明 spec (惰性数据, import 时不建定时器), 由 startJobRuntime
// 统一建节拍、在进程内防重叠、按作业名记错误、优雅关停。node-cron 只当节拍器用

export interface JobContext {
  // 运行时开始关停、或作业的租约丢失时中止: 不要再开始新的工作单元 (下一行、下一批、下一条
  // 任务), 手上这一个做完即返回
  signal: AbortSignal
  // 关停的宽限期满时中止: 在途的外部调用应当放弃, 进程随即退出
  cancelSignal: AbortSignal
}

export interface ScheduledJobSpec {
  // 日志里的作业名, 各作业不得重复
  name: string
  // node-cron 表达式, 按进程所在时区
  schedule: string
  // 跨进程互斥: 持租约执行 (心跳续租, 见 lease.ts), 抢不到这一拍就跳过
  lease?: { key: string; ttlSeconds?: number }
  // 每个时间槽跨进程只执行一次: 执行前占一个不释放的标记键, 已被占就跳过
  slotMarker?: { key: string; ttlSeconds: number }
  run: (ctx: JobContext) => Promise<unknown>
}

export const defineScheduledJob = (spec: ScheduledJobSpec) => spec

export class JobRuntimeStoppedError extends Error {
  constructor() {
    super('作业运行时正在关停')
    this.name = 'JobRuntimeStoppedError'
  }
}

export class JobRuntimeCancelledError extends Error {
  constructor() {
    super('作业运行时的关停宽限期已满')
    this.name = 'JobRuntimeCancelledError'
  }
}

export interface JobRuntime {
  // 停节拍 → 中止 signal → 等在途作业最多 graceMs → 中止 cancelSignal → 再等它们收尾最多
  // JOB_CANCEL_SETTLE_MS。重复调用返回同一次关停
  stop: (graceMs: number) => Promise<void>
}

// 宽限期满、中止在途调用之后, 留给它们释放认领、归还租约的时间
export const JOB_CANCEL_SETTLE_MS = 5_000

// promise 在 ms 内落定返回 true; 超时返回 false (不取消它)
const settlesWithin = async (promise: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export const startJobRuntime = async (
  specs: readonly ScheduledJobSpec[]
): Promise<JobRuntime> => {
  const names = new Set<string>()
  for (const { name } of specs) {
    if (names.has(name)) {
      throw new Error(`作业名重复: ${name}`)
    }
    names.add(name)
  }

  const stopController = new AbortController()
  const cancelController = new AbortController()
  const ctx: JobContext = {
    signal: stopController.signal,
    cancelSignal: cancelController.signal
  }
  // 在途的执行, 按作业名: 同一个作业上一拍没结束时这一拍直接跳过。重叠是常态 (审核池一轮
  // 可以跨好几拍), 不记日志
  const running = new Map<string, Promise<void>>()

  const tick = (spec: ScheduledJobSpec) => async () => {
    if (stopController.signal.aborted || running.has(spec.name)) {
      return
    }
    const execution = (async () => {
      let { signal } = ctx
      try {
        if (
          spec.slotMarker &&
          !(await claimJobSlot(spec.name, spec.slotMarker))
        ) {
          return
        }
        if (!spec.lease) {
          await spec.run(ctx)
          return
        }
        const { lease } = spec
        await withJobLease(
          { name: spec.name, ...lease, signal: ctx.signal },
          (held) => {
            signal = held.signal
            return spec.run({ ...ctx, signal })
          }
        )
      } catch (error) {
        // 作业按 signal 的要求中止时抛出的就是 signal 的 reason (关停, 或已由 lease.ts 记过的
        // 租约丢失), 不算失败
        if (!(signal.aborted && error === signal.reason)) {
          // eslint-disable-next-line no-console
          console.error(`[kun-jobs] ${spec.name} 执行失败:`, error)
        }
      }
    })()
    running.set(spec.name, execution)
    try {
      await execution
    } finally {
      running.delete(spec.name)
    }
  }

  const tasks = specs.map((spec) => {
    const task = cron.createTask(spec.schedule, tick(spec), {
      name: spec.name
    })
    // 到点时事件循环被同步代码堵住或进程过忙, 那一拍被跳过
    task.on('execution:missed', (context) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[kun-jobs] ${spec.name} 错过了 ${context.date.toISOString()} 的一拍 (事件循环被阻塞或进程过忙)`
      )
    })
    return task
  })
  await Promise.all(tasks.map((task) => task.start()))

  let stopping: Promise<void> | null = null
  const stop = async (graceMs: number) => {
    await Promise.all(tasks.map((task) => task.stop()))
    stopController.abort(new JobRuntimeStoppedError())
    if (running.size === 0) {
      return
    }
    // eslint-disable-next-line no-console
    console.log(
      `[kun-jobs] 关停: 等待在途作业 ${[...running.keys()].join(', ')}`
    )
    const settled = Promise.allSettled([...running.values()])
    if (await settlesWithin(settled, graceMs)) {
      return
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[kun-jobs] 关停宽限期满, 中止在途作业 ${[...running.keys()].join(', ')}`
    )
    cancelController.abort(new JobRuntimeCancelledError())
    await settlesWithin(settled, JOB_CANCEL_SETTLE_MS)
  }

  return {
    stop: (graceMs) => (stopping ??= stop(graceMs))
  }
}
