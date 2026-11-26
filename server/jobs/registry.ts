import cron from 'node-cron'
import { kunLog } from '~/lib/log.server'
import { LeaseLostError, claimJobSlot, withJobLease } from './lease'

// 进程内的最小作业层: 定时任务只声明 spec (惰性数据, import 时不建定时器), 由 startJobRuntime
// 统一建节拍、在进程内防重叠、按作业名记完成与失败 (带耗时)、优雅关停。node-cron 只当节拍器用

export interface JobContext {
  // 运行时开始关停、或作业的租约丢失时中止: 不要再开始新的工作单元 (下一行、下一批、下一条
  // 任务), 手上这一个做完即返回
  signal: AbortSignal
  // 关停的宽限期满时中止: 在途的外部调用应当放弃, 进程随即退出
  cancelSignal: AbortSignal
  // 做完一个工作单元: 租约的停滞看门狗重新计时 (lease.ts)。没声明 lease 的作业里是空操作
  progress: () => void
}

export interface ScheduledJobSpec {
  // 日志里的作业名, 各作业不得重复
  name: string
  // node-cron 表达式, 按 startJobRuntime 的 timezone 算
  schedule: string
  // 跨进程互斥: 持租约执行 (心跳续租, 见 lease.ts), 抢不到这一拍就跳过。stallMs 是没有进展
  // (ctx.progress) 多久之后放弃租约, 默认 DEFAULT_LEASE_STALL_MS
  lease?: { key: string; ttlSeconds?: number; stallMs?: number }
  // 每个时间槽跨进程只执行一次: 执行前占一个不释放的标记键, 已被占就跳过。不能与 lease 同时
  // 声明 (标记先占, 租约抢不到的那一拍会白白耗掉这个槽)
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

// timezone: 所有作业的 cron 表达式按它算 (IANA 名), 与进程的 TZ 无关
export const startJobRuntime = async (
  specs: readonly ScheduledJobSpec[],
  { timezone }: { timezone: string }
): Promise<JobRuntime> => {
  const names = new Set<string>()
  for (const { name, lease, slotMarker } of specs) {
    if (names.has(name)) {
      throw new Error(`作业名重复: ${name}`)
    }
    if (lease && slotMarker) {
      throw new Error(`作业 ${name} 不能同时声明 lease 与 slotMarker`)
    }
    names.add(name)
  }

  const stopController = new AbortController()
  const cancelController = new AbortController()
  const ctx: JobContext = {
    signal: stopController.signal,
    cancelSignal: cancelController.signal,
    progress: () => {}
  }
  // 在途的执行, 按作业名: 同一个作业上一拍没结束时这一拍直接跳过。重叠是常态 (审核池一轮
  // 可以跨好几拍), 不记日志
  const running = new Map<string, Promise<void>>()

  const tick = (spec: ScheduledJobSpec) => async () => {
    if (stopController.signal.aborted || running.has(spec.name)) {
      return
    }
    const execution = (async () => {
      // 耗时从这一拍开始算, 含占时间槽与抢租约
      const startedAt = Date.now()
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
        } else {
          const { lease } = spec
          const leased = await withJobLease(
            { name: spec.name, ...lease, signal: ctx.signal },
            (held) => {
              signal = held.signal
              return spec.run({ ...ctx, signal, progress: held.progress })
            }
          )
          // 抢不到租约: 这一拍跳过, 不算完成
          if (!leased.ran) {
            return
          }
        }
        // 正常返回才算完成。返回时 signal 已中止 (关停、租约丢失) 说明作业是被叫停的、
        // 不一定做完了, 不记: 这一行要能当心跳看
        if (!signal.aborted) {
          kunLog('job.finished', { job: spec.name, ms: Date.now() - startedAt })
        }
      } catch (error) {
        // 作业按 signal 的要求中止时抛出的就是 signal 的 reason (关停, 或租约丢失); 作业自己在
        // 里面拿的租约 (计数刷新) 丢了也一样: lease.ts 已经记过, 不再记成失败
        if (
          !(signal.aborted && error === signal.reason) &&
          !(error instanceof LeaseLostError)
        ) {
          kunLog(
            'job.failed',
            { job: spec.name, ms: Date.now() - startedAt },
            error
          )
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
      name: spec.name,
      timezone
    })
    // 到点时事件循环被同步代码堵住或进程过忙, 那一拍被跳过
    task.on('execution:missed', (context) => {
      kunLog('job.tick_missed', {
        job: spec.name,
        at: context.date.toISOString()
      })
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
    kunLog('job.shutdown_waiting', { jobs: [...running.keys()].join(',') })
    const settled = Promise.allSettled([...running.values()])
    if (await settlesWithin(settled, graceMs)) {
      return
    }
    kunLog('job.shutdown_grace_expired', {
      jobs: [...running.keys()].join(',')
    })
    cancelController.abort(new JobRuntimeCancelledError())
    await settlesWithin(settled, JOB_CANCEL_SETTLE_MS)
  }

  return {
    stop: (graceMs) => (stopping ??= stop(graceMs))
  }
}
