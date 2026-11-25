import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeTask {
  schedule: string
  tick: () => Promise<void>
  options: { name?: string }
  listeners: Map<string, (context: { date: Date }) => void>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
}

const { createdTasks } = vi.hoisted(() => ({
  createdTasks: [] as FakeTask[]
}))

vi.mock('node-cron', () => ({
  default: {
    createTask: (
      schedule: string,
      tick: () => Promise<void>,
      options: { name?: string }
    ) => {
      const listeners = new Map()
      const task: FakeTask = {
        schedule,
        tick,
        options,
        listeners,
        start: vi.fn(),
        stop: vi.fn()
      }
      createdTasks.push(task)
      return {
        start: task.start,
        stop: task.stop,
        on: (event: string, listener: (context: { date: Date }) => void) =>
          listeners.set(event, listener)
      }
    }
  }
}))

const { withJobLeaseMock, claimJobSlotMock } = vi.hoisted(() => ({
  withJobLeaseMock: vi.fn(),
  claimJobSlotMock: vi.fn()
}))
vi.mock('~/server/jobs/lease', async (importOriginal) => ({
  LeaseLostError: (await importOriginal<typeof import('~/server/jobs/lease')>())
    .LeaseLostError,
  withJobLease: withJobLeaseMock,
  claimJobSlot: claimJobSlotMock
}))

import {
  JOB_CANCEL_SETTLE_MS,
  JobRuntimeCancelledError,
  JobRuntimeStoppedError,
  defineScheduledJob,
  startJobRuntime as startRuntime
} from '~/server/jobs/registry'
import type { JobContext, ScheduledJobSpec } from '~/server/jobs/registry'

const TIMEZONE = 'Asia/Singapore'
const startJobRuntime = (specs: ScheduledJobSpec[]) =>
  startRuntime(specs, { timezone: TIMEZONE })

let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  createdTasks.length = 0
  withJobLeaseMock.mockReset()
  claimJobSlotMock.mockReset()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const taskOf = (name: string) =>
  createdTasks.find((task) => task.options.name === name)!

// 作业停在半路, 由用例决定何时结束; 记下它拿到的 ctx
const heldJob = (name: string) => {
  const contexts: JobContext[] = []
  const finishers: Array<() => void> = []
  const run = vi.fn((ctx: JobContext) => {
    contexts.push(ctx)
    const { promise, resolve } = Promise.withResolvers<void>()
    finishers.push(resolve)
    return promise
  })
  return {
    spec: defineScheduledJob({ name, schedule: '* * * * *', run }),
    run,
    contexts,
    finish: () => finishers.shift()?.()
  }
}

describe('启动', () => {
  it('每个作业一个节拍, 带上作业名、表达式与时区, 并全部启动', async () => {
    await startJobRuntime([
      defineScheduledJob({ name: 'a', schedule: '0 0 * * *', run: vi.fn() }),
      defineScheduledJob({
        name: 'b',
        schedule: '*/15 * * * * *',
        run: vi.fn()
      })
    ])

    expect(
      createdTasks.map(({ schedule, options }) => [schedule, options])
    ).toEqual([
      ['0 0 * * *', { name: 'a', timezone: TIMEZONE }],
      ['*/15 * * * * *', { name: 'b', timezone: TIMEZONE }]
    ])
    expect(
      createdTasks.every((task) => task.start.mock.calls.length === 1)
    ).toBe(true)
  })

  it('同一个作业不能同时声明 lease 与 slotMarker', async () => {
    await expect(
      startJobRuntime([
        defineScheduledJob({
          name: 'both',
          schedule: '0 0 * * *',
          lease: { key: 'k' },
          slotMarker: { key: 's', ttlSeconds: 3600 },
          run: vi.fn()
        })
      ])
    ).rejects.toThrow('不能同时声明 lease 与 slotMarker')
    expect(createdTasks).toHaveLength(0)
  })

  it('作业名重复时拒绝启动, 不建任何节拍', async () => {
    const spec = defineScheduledJob({
      name: 'a',
      schedule: '* * * * *',
      run: vi.fn()
    })

    await expect(startJobRuntime([spec, spec])).rejects.toThrow('作业名重复: a')
    expect(createdTasks).toHaveLength(0)
  })
})

describe('每一拍', () => {
  it('作业抛错按作业名记一条 error, 不逃出节拍', async () => {
    const error = new Error('db down')
    await startJobRuntime([
      defineScheduledJob({
        name: 'flush',
        schedule: '* * * * *',
        run: async () => {
          throw error
        }
      })
    ])

    await expect(taskOf('flush').tick()).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      '[kun-jobs] flush 执行失败:',
      error
    )
  })

  it('同一个作业上一拍没结束时这一拍跳过, 别的作业照常; 结束后下一拍照常执行', async () => {
    const slow = heldJob('slow')
    const other = heldJob('other')
    await startJobRuntime([slow.spec, other.spec])

    const first = taskOf('slow').tick()
    await taskOf('slow').tick()
    expect(slow.run).toHaveBeenCalledOnce()

    const otherTick = taskOf('other').tick()
    expect(other.run).toHaveBeenCalledOnce()

    slow.finish()
    await first
    const next = taskOf('slow').tick()
    expect(slow.run).toHaveBeenCalledTimes(2)

    slow.finish()
    other.finish()
    await Promise.all([next, otherTick])
  })

  it('错过的一拍按作业名记一条 warn', async () => {
    await startJobRuntime([
      defineScheduledJob({ name: 'reset', schedule: '0 0 * * *', run: vi.fn() })
    ])

    taskOf('reset').listeners.get('execution:missed')!({
      date: new Date('2026-11-26T00:00:00.000Z')
    })

    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        '[kun-jobs] reset 错过了 2026-11-26T00:00:00.000Z'
      )
    )
  })
})

describe('租约与时间槽', () => {
  it('声明了 lease: 持租约执行, ctx.signal 换成租约的 signal (它也接着运行时的关停)', async () => {
    const leaseSignal = new AbortController().signal
    const leaseProgress = vi.fn()
    withJobLeaseMock.mockImplementation(async (_spec, fn) => ({
      ran: true,
      value: await fn({ signal: leaseSignal, progress: leaseProgress })
    }))
    const run = vi.fn(async () => {})
    await startJobRuntime([
      defineScheduledJob({
        name: 'flush',
        schedule: '* * * * *',
        lease: { key: 'patch:views:flush:lock' },
        run
      })
    ])

    await taskOf('flush').tick()

    const [[leaseSpec]] = withJobLeaseMock.mock.calls
    expect(leaseSpec).toEqual({
      name: 'flush',
      key: 'patch:views:flush:lock',
      signal: expect.any(AbortSignal)
    })
    expect(run).toHaveBeenCalledExactlyOnceWith({
      signal: leaseSignal,
      cancelSignal: expect.any(AbortSignal),
      progress: leaseProgress
    })
  })

  it('抢不到租约: 这一拍不执行, 不记日志', async () => {
    withJobLeaseMock.mockResolvedValue({ ran: false })
    const run = vi.fn()
    await startJobRuntime([
      defineScheduledJob({
        name: 'flush',
        schedule: '* * * * *',
        lease: { key: 'k' },
        run
      })
    ])

    await taskOf('flush').tick()

    expect(run).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('租约丢失后作业抛出租约 signal 的 reason: 已由租约记过, 这里不再记成失败', async () => {
    const lost = new AbortController()
    withJobLeaseMock.mockImplementation(async (_spec, fn) => ({
      ran: true,
      value: await fn({ signal: lost.signal, progress: () => {} })
    }))
    await startJobRuntime([
      defineScheduledJob({
        name: 'flush',
        schedule: '* * * * *',
        lease: { key: 'k' },
        run: async ({ signal }) => {
          lost.abort(new Error('lease lost'))
          signal.throwIfAborted()
        }
      })
    ])

    await taskOf('flush').tick()

    expect(errorSpy).not.toHaveBeenCalled()
  })

  // 计数刷新的写锁在作业里面拿 (spec 没有 lease): 它丢了抛出的 LeaseLostError 已由 lease.ts 记过
  it('作业里自己拿的租约丢了: 抛出的 LeaseLostError 不再记成失败', async () => {
    const { LeaseLostError } = await import('~/server/jobs/lease')
    await startJobRuntime([
      defineScheduledJob({
        name: 'counts',
        schedule: '* * * * *',
        run: async () => {
          throw new LeaseLostError('searchCountsRefreshTask', 'gone')
        }
      })
    ])

    await taskOf('counts').tick()

    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('声明了 slotMarker: 先占标记, 已被占就跳过', async () => {
    claimJobSlotMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const run = vi.fn(async () => {})
    const slotMarker = { key: 'cron:reset-daily:lock', ttlSeconds: 3600 }
    await startJobRuntime([
      defineScheduledJob({
        name: 'reset',
        schedule: '0 0 * * *',
        slotMarker,
        run
      })
    ])

    await taskOf('reset').tick()
    await taskOf('reset').tick()

    expect(claimJobSlotMock).toHaveBeenCalledWith('reset', slotMarker)
    expect(run).toHaveBeenCalledOnce()
    expect(withJobLeaseMock).not.toHaveBeenCalled()
  })
})

describe('关停', () => {
  it('先停节拍、中止 signal, 在途作业在宽限期内结束就不中止 cancelSignal', async () => {
    vi.useFakeTimers()
    const job = heldJob('drain')
    const runtime = await startJobRuntime([job.spec])
    const tick = taskOf('drain').tick()
    const [ctx] = job.contexts

    const stopping = runtime.stop(20_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(taskOf('drain').stop).toHaveBeenCalledOnce()
    expect(ctx.signal.aborted).toBe(true)
    expect(ctx.signal.reason).toBeInstanceOf(JobRuntimeStoppedError)

    await vi.advanceTimersByTimeAsync(19_000)
    job.finish()
    await stopping
    await tick
    expect(ctx.cancelSignal.aborted).toBe(false)
  })

  it('宽限期满: 中止 cancelSignal, 再等收尾至多 JOB_CANCEL_SETTLE_MS', async () => {
    vi.useFakeTimers()
    const job = heldJob('moderation')
    const runtime = await startJobRuntime([job.spec])
    void taskOf('moderation').tick()
    const [ctx] = job.contexts
    let stopped = false

    void runtime.stop(20_000).then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(ctx.cancelSignal.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(ctx.cancelSignal.reason).toBeInstanceOf(JobRuntimeCancelledError)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('中止在途作业 moderation')
    )

    // 作业一直不结束: 收尾时间到了照样返回, 由调用方退出进程
    await vi.advanceTimersByTimeAsync(JOB_CANCEL_SETTLE_MS - 1)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(stopped).toBe(true)
  })

  it('没有在途作业时立即返回; 重复调用是同一次关停', async () => {
    const runtime = await startJobRuntime([heldJob('idle').spec])

    const first = runtime.stop(20_000)
    expect(runtime.stop(1)).toBe(first)
    await first
    expect(taskOf('idle').stop).toHaveBeenCalledOnce()
  })

  it('关停之后到来的一拍不再执行', async () => {
    const job = heldJob('late')
    const runtime = await startJobRuntime([job.spec])

    await runtime.stop(20_000)
    await taskOf('late').tick()

    expect(job.run).not.toHaveBeenCalled()
  })

  it('作业按 signal 中止时抛出它的 reason, 不算失败', async () => {
    let started: () => void = () => {}
    const begun = new Promise<void>((resolve) => {
      started = resolve
    })
    const runtime = await startJobRuntime([
      defineScheduledJob({
        name: 'outbox',
        schedule: '* * * * *',
        run: (ctx) =>
          new Promise((_, reject) => {
            ctx.signal.addEventListener('abort', () =>
              reject(ctx.signal.reason)
            )
            started()
          })
      })
    ])
    const tick = taskOf('outbox').tick()
    await begun

    await runtime.stop(20_000)
    await tick

    expect(errorSpy).not.toHaveBeenCalled()
  })
})
