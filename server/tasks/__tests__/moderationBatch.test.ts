import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { moderation_taskModel } from '~/prisma/generated/prisma/models'
import { KUN_MODERATION_HEALTH_KEY } from '~/config/redis'
import {
  MODERATION_BATCH_SIZE,
  MODERATION_CONCURRENCY,
  MODERATION_LEASE_SECONDS
} from '~/constants/moderation'
import { DependencyFailure, classifyHttpStatus } from '~/lib/resilience/failure'

// 批次与失败记账: 取哪些任务、怎么认领、失败算在谁头上。单条任务内部 (黑名单、缓存、
// 送审视图) 由 moderationTask.test.ts 覆盖; 熔断器与记账规则各自的单测在
// server/moderation/__tests__/{breaker,accounting}.test.ts, 这里看 worker 怎么把它们接起来

const {
  findTasksMock,
  updateTaskMock,
  findBlacklistMock,
  getKvMock,
  setKvMock,
  getFileFromS3Mock,
  moderateTextMock,
  moderateImageMock,
  applyModerationVerdictMock,
  markTaskManualMock
} = vi.hoisted(() => ({
  findTasksMock: vi.fn(),
  updateTaskMock: vi.fn(),
  findBlacklistMock: vi.fn(),
  getKvMock: vi.fn(),
  setKvMock: vi.fn(),
  getFileFromS3Mock: vi.fn(),
  moderateTextMock: vi.fn(),
  moderateImageMock: vi.fn(),
  applyModerationVerdictMock: vi.fn(),
  markTaskManualMock: vi.fn()
}))

vi.mock('~/prisma', () => ({
  prisma: {
    moderation_task: { findMany: findTasksMock, updateMany: updateTaskMock },
    moderation_blacklist: { findMany: findBlacklistMock }
  }
}))
vi.mock('~/lib/redis', () => ({ getKv: getKvMock, setKv: setKvMock }))
vi.mock('~/lib/s3', () => ({ getFileFromS3: getFileFromS3Mock }))
vi.mock('~/server/image/transcode', () => ({
  transcodeTrustedAvifToJpeg: async () => Buffer.from('jpeg')
}))
vi.mock('~/server/moderation/apply', () => ({
  applyModerationVerdict: applyModerationVerdictMock,
  markTaskManual: markTaskManualMock
}))
vi.mock(import('~/server/moderation/ai'), async (importOriginal) => ({
  ...(await importOriginal()),
  moderateText: moderateTextMock,
  moderateImage: moderateImageMock
}))

import { ModerationConfigError } from '~/server/moderation/ai'
import {
  createModerationWorker,
  runModerationBatch
} from '~/server/tasks/moderationTask'
import type { ModerationWorker } from '~/server/tasks/moderationTask'

const NOW = new Date('2026-11-20T12:00:00.000Z')
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs)
const leaseStaleBefore = (now: Date) =>
  new Date(now.getTime() - MODERATION_LEASE_SECONDS * 1000)

// ---- 内存里的任务表: 两个 prisma 调用与两个落库函数都落在它上面, 用例可以连跑几批、
// 推进时钟, 最后看每一行停在什么状态

type Row = moderation_taskModel
type Where = {
  id?: number
  status?: string
  next_attempt?: { lte: Date }
  OR?: [{ picked_at: null }, { picked_at: { lt: Date } }]
  content_type?: string | { not: string }
  failure_kind?: string
}
type UpdateArgs = { where: Where; data: Record<string, unknown> }

let rows: Row[] = []
let nextTaskId = 1

const matches = (row: Row, where: Where) => {
  if (where.id !== undefined && row.id !== where.id) {
    return false
  }
  if (where.status !== undefined && row.status !== where.status) {
    return false
  }
  if (where.next_attempt && row.next_attempt > where.next_attempt.lte) {
    return false
  }
  if (
    where.failure_kind !== undefined &&
    row.failure_kind !== where.failure_kind
  ) {
    return false
  }
  if (
    where.OR &&
    row.picked_at !== null &&
    row.picked_at >= where.OR[1].picked_at.lt
  ) {
    return false
  }
  if (typeof where.content_type === 'string') {
    return row.content_type === where.content_type
  }
  if (where.content_type) {
    return row.content_type !== where.content_type.not
  }
  return true
}

// 每条任务的正文各不相同, 模型的 mock 靠它认出是哪一条
const textOf = (taskId: number) => `评论 #${taskId}#`

// 评论各自成组 (全并发); plain 段不经渲染管线
const addTask = (overrides: Partial<Row> = {}): Row => {
  const id = nextTaskId++
  const row = {
    id,
    content_type: 'comment',
    content_id: 10,
    patch_id: null,
    user_id: 7,
    payload: {
      v: 2,
      segments: [{ label: '评论', kind: 'plain', value: textOf(id) }]
    },
    status: 'pending',
    retry: 0,
    defer_count: 0,
    failure_kind: '',
    reject_reason: '',
    next_attempt: new Date(),
    picked_at: null,
    dry_run: false,
    ...overrides
  } as Row
  rows.push(row)
  return row
}

const addAvatarTask = (overrides: Partial<Row> = {}) =>
  addTask({
    content_type: 'avatar',
    content_id: null,
    payload: {
      pendingKey: 'p',
      pendingMiniKey: 'pm',
      avatarKey: 'a',
      avatarMiniKey: 'am',
      avatarLink: 'https://img.example/a',
      pendingLink: 'https://img.example/p'
    },
    ...overrides
  })

const rowOf = (task: Row) => rows.find((row) => row.id === task.id)!

// ---- 模型的行为: 默认放行, 用例按任务 id 指定哪一条怎么失败

const verdict = () => ({
  verdict: { pass: true },
  model: 'test-model',
  tokensIn: 1,
  tokensOut: 1
})

let modelBehaviour: (taskId: number) => Promise<ReturnType<typeof verdict>>

const taskIdOf = (userMessage: string) =>
  Number(/#(\d+)#/.exec(userMessage)?.[1])

const httpFailure = (status: number, retryAfterMs: number | null = null) =>
  new DependencyFailure({
    dependency: 'moderation_ai',
    scope: classifyHttpStatus(status),
    message: `Moderation AI request failed with status ${status}`,
    status,
    retryAfterMs
  })

// 模型的地址或密钥没配 (ai.ts 在发请求之前就抛出, 没有状态码)
const missingCredentials = () =>
  new DependencyFailure({
    dependency: 'moderation_ai',
    scope: 'misconfigured',
    message: 'MODERATION_AI_BASE_URL or MODERATION_AI_API_KEY is not configured'
  })

const badOutput = () =>
  new DependencyFailure({
    dependency: 'moderation_ai',
    scope: 'request',
    message: 'Moderation verdict is not valid JSON: 好的'
  })

const failAll = (error: () => unknown) => {
  modelBehaviour = async () => {
    throw error()
  }
}

const failOnly = (tasks: Row[], error: () => unknown) => {
  const ids = new Set(tasks.map((task) => task.id))
  modelBehaviour = async (taskId) => {
    if (ids.has(taskId)) {
      throw error()
    }
    return verdict()
  }
}

const recover = () => {
  modelBehaviour = async () => verdict()
}

// ---- 断言用的取数

const updateCalls = () =>
  updateTaskMock.mock.calls.map(([args]) => args as UpdateArgs)

// 认领写入带一个新的租约时间戳; 记账写入把租约清空
const claimsOf = (task: Row) =>
  updateCalls().filter(
    ({ where, data }) => where.id === task.id && data.picked_at instanceof Date
  )

const accountingOf = (task: Row) =>
  updateCalls().filter(
    ({ where, data }) => where.id === task.id && data.picked_at === null
  )

const fetchCalls = () =>
  findTasksMock.mock.calls.map(
    ([args]) => args as { where: Where; orderBy: unknown; take: number }
  )

const fetchedLanes = () =>
  fetchCalls().map(({ where, take }) => ({
    lane: where.content_type === 'avatar' ? 'avatar' : 'text',
    take
  }))

const modelCalledFor = () =>
  moderateTextMock.mock.calls.map(([, , message]) =>
    taskIdOf(message as string)
  )

const healthReports = () =>
  setKvMock.mock.calls
    .filter(([key]) => key === KUN_MODERATION_HEALTH_KEY)
    .map(([, value, ttl]) => ({ ...JSON.parse(value as string), ttl }))

let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let consoleWarnSpy: ReturnType<typeof vi.spyOn>

const BREAKER_LOG_PREFIX = '[kun-moderation-breaker] '

interface BreakerLog {
  lane: string
  type: string
  from: string
  to: string
  reason: string | null
}

const breakerLogs = (): BreakerLog[] =>
  consoleWarnSpy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith(BREAKER_LOG_PREFIX))
    .map((line: string) => JSON.parse(line.slice(BREAKER_LOG_PREFIX.length)))

// 默认是上线的配置: 系统性故障检测只记日志
const newWorker = (systematic: 'log' | 'enforce' = 'log') =>
  createModerationWorker({ systematic })

// 推进时钟后再跑一批; 取任务与调模型的记录只留这一批的
const runAt = async (worker: ModerationWorker, offsetMs: number) => {
  vi.setSystemTime(at(offsetMs))
  findTasksMock.mockClear()
  moderateTextMock.mockClear()
  await runModerationBatch(worker)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.resetAllMocks()
  vi.stubEnv('MODERATION_AI_BASE_URL', 'http://ai.test/v1')
  vi.stubEnv('MODERATION_AI_API_KEY', 'test-key')
  vi.stubEnv('MODERATION_AI_TEXT_MODEL', 'text-model')
  vi.stubEnv('MODERATION_AI_VISION_MODEL', 'vision-model')
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  rows = []
  nextTaskId = 1
  recover()

  findTasksMock.mockImplementation(
    async ({
      where,
      orderBy,
      take
    }: {
      where: Where
      orderBy: { next_attempt: 'asc' | 'desc' }
      take: number
    }) =>
      rows
        .filter((row) => matches(row, where))
        .sort(
          (a, b) =>
            (a.next_attempt.getTime() - b.next_attempt.getTime()) *
            (orderBy.next_attempt === 'asc' ? 1 : -1)
        )
        .slice(0, take)
        // worker 拿到的是取任务那一刻的快照
        .map((row) => ({ ...row }))
  )
  updateTaskMock.mockImplementation(async ({ where, data }: UpdateArgs) => {
    const row = rows.find((candidate) => matches(candidate, where))
    if (!row) {
      return { count: 0 }
    }
    const target = row as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(data)) {
      const increment =
        typeof value === 'object' && value !== null && 'increment' in value
          ? Number(value.increment)
          : null
      target[key] = increment === null ? value : Number(target[key]) + increment
    }
    return { count: 1 }
  })
  markTaskManualMock.mockImplementation(
    async (taskId: number, failure: { kind: string; reason: string }) => {
      const row = rows.find((candidate) => candidate.id === taskId)!
      row.status = 'manual'
      row.failure_kind = failure.kind
      row.reject_reason = failure.reason
      return { count: 1 }
    }
  )
  applyModerationVerdictMock.mockImplementation(
    async ({ task, approved }: { task: Row; approved: boolean }) => {
      rowOf(task).status = approved ? 'approved' : 'rejected'
      return true
    }
  )
  findBlacklistMock.mockResolvedValue([])
  getKvMock.mockResolvedValue(null)
  setKvMock.mockResolvedValue(undefined)
  getFileFromS3Mock.mockResolvedValue(Buffer.from('avatar'))
  moderateTextMock.mockImplementation(async (_policy, _type, message: string) =>
    modelBehaviour(taskIdOf(message))
  )
  moderateImageMock.mockImplementation(async () => verdict())
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

// 让已经能走的微任务都走完: 该发起的调用都已发起, 被挡住的确实没动
const settle = async () => {
  for (let i = 0; i < 60; i++) {
    await Promise.resolve()
  }
}

// 每次模型调用都停在半路, 由用例按任务逐个放行或让它失败
const gateModelCalls = () => {
  const calls = new Map<
    number,
    { succeed: () => void; fail: (error: unknown) => void }
  >()
  modelBehaviour = (taskId) =>
    new Promise((resolve, reject) => {
      calls.set(taskId, { succeed: () => resolve(verdict()), fail: reject })
    })
  return (task: Row) => calls.get(task.id)!
}

describe('取任务', () => {
  it('按车道各取一次: 待处理、已到重试时刻、租约为空或已过期, 按就绪时刻先后', async () => {
    await runModerationBatch(newWorker())

    const claimable = {
      status: 'pending',
      next_attempt: { lte: NOW },
      OR: [{ picked_at: null }, { picked_at: { lt: leaseStaleBefore(NOW) } }]
    }
    expect(fetchCalls()).toEqual([
      {
        where: { ...claimable, content_type: { not: 'avatar' } },
        orderBy: { next_attempt: 'asc' },
        take: MODERATION_BATCH_SIZE
      },
      {
        where: { ...claimable, content_type: 'avatar' },
        orderBy: { next_attempt: 'asc' },
        take: MODERATION_BATCH_SIZE
      }
    ])
    expect(updateTaskMock).not.toHaveBeenCalled()
  })

  it('两条车道合起来仍只处理一批的量, 就绪早的先', async () => {
    const late = Array.from({ length: MODERATION_BATCH_SIZE }, () =>
      addTask({ next_attempt: at(-1_000) })
    )
    const avatars = Array.from({ length: 3 }, () =>
      addAvatarTask({ next_attempt: at(-5_000) })
    )

    await runModerationBatch(newWorker())

    expect(avatars.map((task) => rowOf(task).status)).toEqual([
      'approved',
      'approved',
      'approved'
    ])
    expect(
      late.filter((task) => rowOf(task).status === 'approved')
    ).toHaveLength(MODERATION_BATCH_SIZE - 3)
    expect(late.slice(-3).map((task) => claimsOf(task))).toEqual([[], [], []])
  })

  it('每批上报一次两条车道的状态, 两分钟不续就过期', async () => {
    await runModerationBatch(newWorker())

    const closed = {
      state: 'closed',
      reason: null,
      since: null,
      openUntil: null,
      opens: 0,
      lastError: ''
    }
    expect(healthReports()).toEqual([
      {
        at: NOW.getTime(),
        lanes: { text: closed, avatar: closed },
        ttl: 120
      }
    ])
  })

  // 只在批次开头报的话, 管理端看到的总比实际落后一拍: 探测失败之后还显示「探测中」
  it('批次结束时再报一次: 这一批把车道打开了, 管理端马上看得到', async () => {
    addTask()
    failAll(() => httpFailure(401))

    await runModerationBatch(newWorker())

    expect(healthReports().map((report) => report.lanes.text.state)).toEqual([
      'closed',
      'open'
    ])
  })

  // 一次慢的模型调用可以让批次持续数分钟, 期间状态键 (两分钟过期) 不能断
  it('批次进行中每 30 秒续报一次, 批次结束后不再报', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
    const task = addTask()
    const call = gateModelCalls()

    const batch = runModerationBatch(newWorker())
    await settle()
    expect(healthReports()).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(healthReports()).toHaveLength(3)

    call(task).succeed()
    await batch
    expect(healthReports()).toHaveLength(4)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(healthReports()).toHaveLength(4)
  })

  it('状态上报失败不影响审核', async () => {
    const task = addTask()
    setKvMock.mockRejectedValue(new Error('redis down'))

    await runModerationBatch(newWorker())

    expect(rowOf(task).status).toBe('approved')
  })
})

describe('审核策略', () => {
  it('每批从环境变量读一次, 这一批的调用用同一份', async () => {
    vi.stubEnv('MODERATION_AI_BASE_URL', 'http://ai.test/v1')
    vi.stubEnv('MODERATION_AI_API_KEY', 'test-key')
    vi.stubEnv('MODERATION_AI_TEXT_MODEL', 'text-model-a')
    vi.stubEnv('MODERATION_AI_TEXT_REASONING_EFFORT', '')
    addTask()
    addTask()

    try {
      await runModerationBatch(newWorker())
    } finally {
      vi.unstubAllEnvs()
    }

    const [first, second] = moderateTextMock.mock.calls.map(([used]) => used)
    expect(first).toMatchObject({
      provider: { baseUrl: 'http://ai.test/v1', apiKey: 'test-key' },
      text: { model: 'text-model-a', reasoningEffort: undefined }
    })
    expect(second).toBe(first)
  })
})

describe('认领', () => {
  it('调模型之前先给这一行盖租约, 认领条件与取任务的谓词相同', async () => {
    const task = addTask()

    await runModerationBatch(newWorker())

    expect(claimsOf(task)).toEqual([
      {
        where: {
          id: task.id,
          status: 'pending',
          next_attempt: { lte: NOW },
          OR: [
            { picked_at: null },
            { picked_at: { lt: leaseStaleBefore(NOW) } }
          ]
        },
        data: { picked_at: NOW }
      }
    ])
    expect(moderateTextMock).toHaveBeenCalledTimes(1)
    expect(applyModerationVerdictMock).toHaveBeenCalledTimes(1)
    expect(accountingOf(task)).toEqual([])
    expect(markTaskManualMock).not.toHaveBeenCalled()
  })

  it('没抢到 (另一个 worker 已认领) 就跳过, 不调模型也不记账', async () => {
    addTask()
    updateTaskMock.mockResolvedValue({ count: 0 })

    await runModerationBatch(newWorker())

    expect(updateTaskMock).toHaveBeenCalledTimes(1)
    expect(moderateTextMock).not.toHaveBeenCalled()
    expect(applyModerationVerdictMock).not.toHaveBeenCalled()
    expect(markTaskManualMock).not.toHaveBeenCalled()
  })
})

// 取到时租约非空, 说明上一个 worker 崩在了半路: 既没落裁决也没写退避
describe('回收过期租约', () => {
  const stale = () => at(-(MODERATION_LEASE_SECONDS + 1) * 1000)

  it('认领的同一条语句里把 retry 加一, 然后照常处理', async () => {
    const task = addTask({ picked_at: stale() })

    await runModerationBatch(newWorker())

    expect(claimsOf(task).map(({ data }) => data)).toEqual([
      { picked_at: NOW, retry: { increment: 1 } }
    ])
    expect(rowOf(task)).toMatchObject({ status: 'approved', retry: 1 })
  })

  it('回收后又抛错: retry 只净加一 (绝对写, 与认领时的自增落在同一个值)', async () => {
    const task = addTask({ picked_at: stale() })
    failAll(() => new Error('render crashed'))

    await runModerationBatch(newWorker())

    expect(accountingOf(task).map(({ data }) => data)).toEqual([
      {
        retry: 1,
        failure_kind: 'internal',
        next_attempt: at(5_000),
        picked_at: null
      }
    ])
    expect(rowOf(task).retry).toBe(1)
  })

  it('回收把预算用完: 转人工, 不再调模型', async () => {
    const task = addTask({ picked_at: stale(), retry: 2 })

    await runModerationBatch(newWorker())

    expect(markTaskManualMock).toHaveBeenCalledTimes(1)
    expect(markTaskManualMock).toHaveBeenCalledWith(task.id, {
      kind: 'crash_loop',
      reason: '多次处理未完成, 已转人工复核'
    })
    expect(moderateTextMock).not.toHaveBeenCalled()
  })
})

describe('并发与分组', () => {
  // 让每次模型调用停在半路, 由测试逐个放行
  const holdModelCalls = () => {
    const releases: Array<() => void> = []
    let inFlight = 0
    let peak = 0
    modelBehaviour = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      const { promise, resolve } = Promise.withResolvers<void>()
      releases.push(resolve)
      await promise
      inFlight--
      return verdict()
    }
    return {
      releases,
      peak: () => peak,
      settle
    }
  }

  it('同时在途的模型调用不超过并发上限', async () => {
    const tasks = Array.from({ length: MODERATION_CONCURRENCY + 2 }, () =>
      addTask()
    )
    const model = holdModelCalls()

    const batch = runModerationBatch(newWorker())
    await model.settle()
    expect(model.releases).toHaveLength(MODERATION_CONCURRENCY)

    while (moderateTextMock.mock.calls.length < tasks.length) {
      model.releases.shift()?.()
      await model.settle()
    }
    model.releases.forEach((release) => release())
    await batch

    expect(model.peak()).toBe(MODERATION_CONCURRENCY)
    expect(applyModerationVerdictMock).toHaveBeenCalledTimes(tasks.length)
  })

  it('同一个 patch 的资源与评价串行, 不同 patch 之间并行', async () => {
    const plain = (label: string, id: number) => ({
      v: 2,
      segments: [{ label, kind: 'plain', value: textOf(id) }],
      name: 'n'
    })
    const resource = addTask({ content_type: 'resource', patch_id: 3 })
    resource.payload = plain('标题', resource.id)
    const rating = addTask({ content_type: 'rating', patch_id: 3 })
    rating.payload = plain('评价', rating.id)
    const otherRating = addTask({ content_type: 'rating', patch_id: 4 })
    otherRating.payload = plain('评价', otherRating.id)
    const model = holdModelCalls()

    const batch = runModerationBatch(newWorker())
    await model.settle()

    // patch 3 的第二条要等第一条结算; patch 4 不受它影响
    expect(modelCalledFor()).toEqual([resource.id, otherRating.id])
    expect(claimsOf(rating)).toEqual([])

    model.releases.shift()?.()
    await model.settle()
    expect(claimsOf(rating)).toHaveLength(1)

    model.releases.forEach((release) => release())
    await batch
    expect(applyModerationVerdictMock).toHaveBeenCalledTimes(3)
  })

  it('一条任务的记账写库失败不影响别的组, 批次等所有 worker 结束才返回', async () => {
    const broken = addTask()
    const healthy = addTask()
    failOnly([broken], () => new Error('render crashed'))
    const applyUpdate = updateTaskMock.getMockImplementation()!
    updateTaskMock.mockImplementation(async (args: UpdateArgs) => {
      if (args.data.picked_at === null) {
        throw new Error('db down')
      }
      return applyUpdate(args)
    })

    await expect(runModerationBatch(newWorker())).resolves.toBeUndefined()

    expect(rowOf(healthy).status).toBe('approved')
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Moderation worker crashed:',
      expect.objectContaining({ message: 'db down' })
    )
  })
})

describe('供应商整体不可用', () => {
  it('503 跨任务连续出现: 车道打开, 没有一条被扣重试预算, 也没有一条转人工', async () => {
    const worker = newWorker()
    const tasks = Array.from({ length: 7 }, () => addTask())
    failAll(() => httpFailure(503))

    await runAt(worker, 0)

    expect(worker.breakers.text.snapshot()).toMatchObject({
      state: 'open',
      reason: 'dependency',
      openUntil: at(30_000).getTime()
    })
    expect(markTaskManualMock).not.toHaveBeenCalled()
    const after = tasks.map((task) => rowOf(task))
    expect(after.every((row) => row.status === 'pending')).toBe(true)
    expect(after.every((row) => row.retry === 0)).toBe(true)
    // 打开之前的三次失败各扣一次推迟预算; 同时在途的另外两条是打开之后才返回的, 不扣;
    // 还没开始的两条没有被认领, 也没有调模型
    expect(after.map((row) => row.defer_count)).toEqual([1, 1, 1, 0, 0, 0, 0])
    expect(after.map((row) => row.failure_kind)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      '',
      ''
    ])
    expect(modelCalledFor()).toHaveLength(MODERATION_CONCURRENCY)
    expect(claimsOf(tasks[5])).toEqual([])
    expect(claimsOf(tasks[6])).toEqual([])
    // 都要等到车道的下一次探测之后
    expect(
      after.slice(0, 5).every((row) => row.next_attempt >= at(30_000))
    ).toBe(true)
    expect(after.slice(0, 5).every((row) => row.picked_at === null)).toBe(true)
    // 打开之后才返回的那两条: 写入里既没有 retry 也没有 defer_count
    expect(accountingOf(tasks[3])).toEqual([
      {
        where: { id: tasks[3].id, status: 'pending' },
        data: {
          failure_kind: 'unavailable',
          next_attempt: at(30_000),
          picked_at: null
        }
      }
    ])
    // 车道的开合各留一行日志, 排障时按前缀 grep
    expect(breakerLogs()).toEqual([
      {
        lane: 'text',
        type: 'transition',
        from: 'closed',
        to: 'open',
        reason: 'dependency',
        since: NOW.getTime(),
        openUntil: at(30_000).getTime(),
        opens: 1,
        lastError: 'Moderation AI request failed with status 503'
      }
    ])
  })

  it('打开期间不取这条车道的任务, 另一条车道照常', async () => {
    const worker = newWorker()
    addTask()
    addTask()
    addTask()
    failAll(() => httpFailure(503))
    await runAt(worker, 0)
    const avatar = addAvatarTask({ next_attempt: at(15_000) })

    await runAt(worker, 15_000)

    expect(fetchedLanes()).toEqual([
      { lane: 'avatar', take: MODERATION_BATCH_SIZE }
    ])
    expect(moderateTextMock).not.toHaveBeenCalled()
    expect(rowOf(avatar).status).toBe('approved')
  })

  it('到点后只取一条去探测; 探测失败重新打开且不扣这条任务, 探测成功后恢复整批处理', async () => {
    const worker = newWorker()
    Array.from({ length: 4 }, () => addTask())
    failAll(() => httpFailure(503))
    await runAt(worker, 0)
    const before = rows.map((row) => ({ ...row }))

    // 第一次探测: 供应商仍不可用
    await runAt(worker, 30_000)
    expect(fetchedLanes()).toContainEqual({ lane: 'text', take: 1 })
    expect(modelCalledFor()).toHaveLength(1)
    expect(worker.breakers.text.snapshot()).toMatchObject({
      state: 'open',
      opens: 2,
      openUntil: at(90_000).getTime()
    })
    const probed = rows.find((row) => row.id === modelCalledFor()[0])!
    expect(probed).toMatchObject({
      status: 'pending',
      retry: 0,
      defer_count: before.find((row) => row.id === probed.id)!.defer_count,
      next_attempt: at(90_000)
    })

    // 第二次探测: 供应商恢复
    recover()
    await runAt(worker, 90_000)
    expect(modelCalledFor()).toHaveLength(1)
    expect(worker.breakers.text.snapshot().state).toBe('closed')

    // 之后整批照常
    await runAt(worker, 105_000)
    expect(fetchedLanes()).toContainEqual({
      lane: 'text',
      take: MODERATION_BATCH_SIZE
    })
    expect(rows.every((row) => row.status === 'approved')).toBe(true)
    expect(markTaskManualMock).not.toHaveBeenCalled()
  })

  // 探测要回答「依赖现在好了吗」。把车道打开的可能只是一波各有毛病的内容 (只有它们
  // 被网关 403): 失败过的很快到重试时刻, 同一波里没轮到的入队更早, 按就绪时刻取的话
  // 探测一次次落在它们身上、暂停逐次翻倍, 后到的正常内容要等十几分钟
  it('探测取没失败过的任务里最新到的那一条: 一波各有毛病的内容不会让后到的正常内容一直等', async () => {
    const worker = newWorker()
    const poison = Array.from({ length: 7 }, () => addTask())
    failOnly(poison, () => httpFailure(403))
    await runAt(worker, 0)
    expect(worker.breakers.text.snapshot().state).toBe('open')
    // 同时在途的 5 条都失败过了; 后 2 条没轮到, 仍是没失败过的, 入队比下面这条早
    expect(poison.map((task) => rowOf(task).failure_kind !== '')).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false
    ])

    const healthy = addTask({ next_attempt: at(10_000) })
    await runAt(worker, 30_000)

    expect(fetchCalls()[0]).toMatchObject({
      where: { content_type: { not: 'avatar' }, failure_kind: '' },
      orderBy: { next_attempt: 'desc' },
      take: 1
    })
    expect(modelCalledFor()).toEqual([healthy.id])
    expect(rowOf(healthy).status).toBe('approved')
    expect(worker.breakers.text.snapshot().state).toBe('closed')
  })

  // 故障结束后队列里可能只剩失败过的任务: 它们也得能当探测, 否则积压永远不动
  it('队列里只剩失败过的任务时, 探测取就绪最早的那一条', async () => {
    const worker = newWorker()
    const tasks = Array.from({ length: 5 }, () => addTask())
    failAll(() => httpFailure(503))
    await runAt(worker, 0)
    // 前 3 条扣了推迟、60 秒后才到点; 后 2 条是车道打开之后才返回的, 探测时刻就到点
    recover()

    await runAt(worker, 30_000)

    // 先问有没有没失败过的, 没有再按就绪时刻取; 两次都只取一条
    expect(fetchedLanes()).toEqual([
      { lane: 'text', take: 1 },
      { lane: 'avatar', take: MODERATION_BATCH_SIZE },
      { lane: 'text', take: 1 }
    ])
    expect(modelCalledFor()).toEqual([tasks[3].id])
    expect(worker.breakers.text.snapshot().state).toBe('closed')
  })

  it('401 第一次就打开车道, 这一次照样扣推迟预算', async () => {
    const worker = newWorker()
    const task = addTask()
    failAll(() => httpFailure(401))

    await runAt(worker, 0)

    expect(worker.breakers.text.snapshot()).toMatchObject({
      state: 'open',
      reason: 'misconfigured'
    })
    expect(rowOf(task)).toMatchObject({
      status: 'pending',
      retry: 0,
      defer_count: 1,
      failure_kind: 'misconfigured',
      next_attempt: at(60_000)
    })
    // 推迟只写 defer_count, 不动 retry; 只落在仍待处理的行上, 租约清空
    expect(accountingOf(task)).toEqual([
      {
        where: { id: task.id, status: 'pending' },
        data: {
          defer_count: 1,
          failure_kind: 'misconfigured',
          next_attempt: at(60_000),
          picked_at: null
        }
      }
    ])
  })

  // 引入车道之前是逐条立即转人工; 现在它和 provider 回 401 是一回事
  it('模型的地址或密钥没配: 车道打开, 任务留在队列里等配置改好', async () => {
    const worker = newWorker()
    const tasks = Array.from({ length: 3 }, () => addTask())
    failAll(missingCredentials)

    await runAt(worker, 0)

    expect(worker.breakers.text.snapshot()).toMatchObject({
      state: 'open',
      reason: 'misconfigured',
      lastError:
        'MODERATION_AI_BASE_URL or MODERATION_AI_API_KEY is not configured'
    })
    expect(markTaskManualMock).not.toHaveBeenCalled()
    expect(tasks.map((task) => rowOf(task).status)).toEqual([
      'pending',
      'pending',
      'pending'
    ])
  })

  it('带 Retry-After 的 429 第一次就打开车道, 车道与任务都等到它给的时刻', async () => {
    const worker = newWorker()
    const task = addTask()
    failAll(() => httpFailure(429, 120_000))

    await runAt(worker, 0)

    expect(worker.breakers.text.snapshot()).toMatchObject({
      state: 'open',
      reason: 'rate_limited',
      openUntil: at(120_000).getTime()
    })
    expect(rowOf(task)).toMatchObject({
      defer_count: 1,
      failure_kind: 'rate_limited',
      next_attempt: at(120_000)
    })
  })
})

describe('探测名额', () => {
  // 让文本车道停在「到点、等探测」
  const openThenWait = async () => {
    const worker = newWorker()
    const opener = addTask()
    failOnly([opener], () => httpFailure(401))
    await runAt(worker, 0)
    // 这条任务本身推迟得更久, 不参与下面的探测
    rowOf(opener).next_attempt = at(3_600_000)
    recover()
    return worker
  }

  const probeAgainAt = async (worker: ModerationWorker, offsetMs: number) => {
    const next = addTask({ next_attempt: at(offsetMs - 1) })
    await runAt(worker, offsetMs)
    expect(fetchedLanes()).toContainEqual({ lane: 'text', take: 1 })
    expect(rowOf(next).status).toBe('approved')
    expect(worker.breakers.text.snapshot().state).toBe('closed')
  }

  it('没有可认领的任务: 归还, 下一批还能探测', async () => {
    const worker = await openThenWait()

    await runAt(worker, 30_000)
    expect(worker.breakers.text.snapshot().state).toBe('half_open')

    await probeAgainAt(worker, 45_000)
  })

  it('探测的那条在本地就落定了 (命中缓存): 归还, 车道不因此闭合', async () => {
    const worker = await openThenWait()
    const cached = addTask({ next_attempt: at(29_000) })
    getKvMock.mockResolvedValueOnce(JSON.stringify({ pass: true }))

    await runAt(worker, 30_000)
    expect(rowOf(cached).status).toBe('approved')
    expect(moderateTextMock).not.toHaveBeenCalled()
    expect(worker.breakers.text.snapshot().state).toBe('half_open')

    await probeAgainAt(worker, 45_000)
  })

  it.each([
    [
      '载荷不可读',
      (): Partial<Row> => ({ payload: 'broken' as unknown as Row['payload'] })
    ],
    [
      '回收把预算用完',
      (): Partial<Row> => ({
        picked_at: at(-(MODERATION_LEASE_SECONDS + 1) * 1000),
        retry: 2
      })
    ]
  ])('探测的那条没调到模型就转人工了 (%s): 归还', async (_name, overrides) => {
    const worker = await openThenWait()
    const settled = addTask({ next_attempt: at(29_000), ...overrides() })

    await runAt(worker, 30_000)
    expect(rowOf(settled).status).toBe('manual')
    expect(moderateTextMock).not.toHaveBeenCalled()
    expect(worker.breakers.text.snapshot().state).toBe('half_open')

    await probeAgainAt(worker, 45_000)
  })

  it('探测的那条撞上「这一类模型没配」: 归还, 不算探测失败', async () => {
    const worker = await openThenWait()
    const unconfigured = addTask({ next_attempt: at(29_000) })
    failOnly(
      [unconfigured],
      () =>
        new ModerationConfigError('MODERATION_AI_TEXT_MODEL is not configured')
    )

    await runAt(worker, 30_000)
    expect(rowOf(unconfigured).status).toBe('manual')
    expect(worker.breakers.text.snapshot()).toMatchObject({
      state: 'half_open',
      opens: 1
    })

    await probeAgainAt(worker, 45_000)
  })

  // 另一条车道排在前面的任务占满了批次, 探测的那一条没进这一批
  it('探测的那条被两条车道的合并截掉: 归还, 下一批照样去探测', async () => {
    const worker = await openThenWait()
    Array.from({ length: MODERATION_BATCH_SIZE }, (_, index) =>
      addAvatarTask({ user_id: 200 + index, next_attempt: at(1_000) })
    )
    const cut = addTask({ next_attempt: at(29_000) })

    await runAt(worker, 30_000)
    expect(fetchedLanes()).toContainEqual({ lane: 'text', take: 1 })
    expect(claimsOf(cut)).toEqual([])
    expect(worker.breakers.text.snapshot().state).toBe('half_open')

    await runAt(worker, 45_000)
    expect(fetchedLanes()).toContainEqual({ lane: 'text', take: 1 })
    expect(rowOf(cut).status).toBe('approved')
    expect(worker.breakers.text.snapshot().state).toBe('closed')
  })

  // 模型答复了, 文本车道的依赖就是好的; 之后落库失败是这条任务自己的事
  it('探测的那条模型已给出裁决、落库时才失败: 车道闭合, 失败按闭合的车道记账', async () => {
    const worker = await openThenWait()
    const probe = addTask({ next_attempt: at(29_000) })
    const applyVerdict = applyModerationVerdictMock.getMockImplementation()!
    applyModerationVerdictMock.mockRejectedValueOnce(
      new Error('deadlock detected')
    )

    await runAt(worker, 30_000)

    expect(moderateTextMock).toHaveBeenCalledTimes(1)
    expect(worker.breakers.text.snapshot().state).toBe('closed')
    expect(rowOf(probe)).toMatchObject({
      status: 'pending',
      retry: 1,
      defer_count: 0,
      failure_kind: 'internal',
      next_attempt: at(35_000)
    })
    applyModerationVerdictMock.mockImplementation(applyVerdict)
  })

  // 探测撞上的是这条内容自己的毛病: 依赖答复了, 车道闭合; 不闭合的话一条输出
  // 确定性损坏的内容排在队首, 就能让已经恢复的车道一轮轮地开下去
  it('探测的那条模型输出不合约定: 车道闭合, 这一次不扣它, 下一次照常扣', async () => {
    const worker = await openThenWait()
    const poison = addTask({ next_attempt: at(29_000) })
    failOnly([poison], badOutput)

    await runAt(worker, 30_000)
    expect(worker.breakers.text.snapshot().state).toBe('closed')
    expect(rowOf(poison)).toMatchObject({
      status: 'pending',
      retry: 0,
      defer_count: 0,
      failure_kind: 'bad_output',
      next_attempt: at(30_000)
    })

    await runAt(worker, 45_000)
    expect(rowOf(poison)).toMatchObject({ retry: 1, next_attempt: at(50_000) })
    expect(worker.breakers.text.snapshot().state).toBe('closed')
  })

  // 车道打开之前就发出的调用可以拖到探测期间才返回: 它不是探测的结果
  it('探测进行中, 更早的在途调用失败了: 不算探测失败, 车道等探测自己的结果', async () => {
    const worker = newWorker()
    const opener = addTask()
    const slow = addTask()
    const call = gateModelCalls()

    const first = runModerationBatch(worker)
    await settle()
    call(opener).fail(httpFailure(401))
    await settle()
    expect(worker.breakers.text.snapshot().state).toBe('open')

    // 第一批还没结束 (slow 仍在途), 到点后另一批放出探测
    vi.setSystemTime(at(30_000))
    const probe = addTask({ next_attempt: at(1_000) })
    const second = runModerationBatch(worker)
    await settle()
    expect(worker.breakers.text.snapshot().state).toBe('half_open')

    call(slow).fail(httpFailure(503))
    await settle()
    expect(worker.breakers.text.snapshot()).toMatchObject({
      state: 'half_open',
      opens: 1
    })
    // 它的失败不扣预算, 等车道的探测时刻 (已到) 之后再试
    expect(rowOf(slow)).toMatchObject({
      status: 'pending',
      retry: 0,
      defer_count: 0,
      next_attempt: at(30_000)
    })

    call(probe).succeed()
    await Promise.all([first, second])
    expect(worker.breakers.text.snapshot().state).toBe('closed')
    expect(breakerLogs().map(({ from, to }) => `${from}→${to}`)).toEqual([
      'closed→open',
      'open→half_open',
      'half_open→closed'
    ])
  })

  it('探测的那条没抢到认领: 归还', async () => {
    const worker = await openThenWait()
    const taken = addTask({ next_attempt: at(29_000) })
    updateTaskMock.mockImplementationOnce(async () => ({ count: 0 }))

    await runAt(worker, 30_000)
    expect(rowOf(taken).status).toBe('pending')
    expect(worker.breakers.text.snapshot().state).toBe('half_open')

    rowOf(taken).next_attempt = at(3_600_000)
    await probeAgainAt(worker, 45_000)
  })

  it('取任务的查询失败: 归还', async () => {
    const worker = await openThenWait()
    findTasksMock.mockRejectedValueOnce(new Error('db down'))

    vi.setSystemTime(at(30_000))
    await expect(runModerationBatch(worker)).rejects.toThrow('db down')

    await probeAgainAt(worker, 45_000)
  })

  it('探测的那条还没轮到批次就中断了 (读黑名单失败): 归还', async () => {
    const worker = await openThenWait()
    // 黑名单在进程内缓存一分钟 (模块级, 跨用例保留): 挑一个任何用例都没到过的时刻,
    // 保证这一批要重新读库
    const later = 36_000_000
    rowOf(rows[0]).next_attempt = at(later * 2)
    const waiting = addTask({ next_attempt: at(later) })
    findBlacklistMock.mockRejectedValueOnce(new Error('db down'))

    vi.setSystemTime(at(later))
    await expect(runModerationBatch(worker)).rejects.toThrow('db down')
    expect(rowOf(waiting).status).toBe('pending')

    await runAt(worker, later + 15_000)
    expect(rowOf(waiting).status).toBe('approved')
    expect(worker.breakers.text.snapshot().state).toBe('closed')
  })
})

describe('这条内容自己的失败', () => {
  it('模型输出不合约定: 扣重试预算, 第三次转人工, 车道不打开', async () => {
    const worker = newWorker()
    const poison = addTask()
    const healthy = addTask()
    failOnly([poison], badOutput)

    await runAt(worker, 0)
    expect(rowOf(poison)).toMatchObject({
      status: 'pending',
      retry: 1,
      defer_count: 0,
      failure_kind: 'bad_output',
      next_attempt: at(5_000)
    })
    // 重试只写 retry, 不动 defer_count
    expect(accountingOf(poison)).toEqual([
      {
        where: { id: poison.id, status: 'pending' },
        data: {
          retry: 1,
          failure_kind: 'bad_output',
          next_attempt: at(5_000),
          picked_at: null
        }
      }
    ])
    expect(rowOf(healthy).status).toBe('approved')

    await runAt(worker, 15_000)
    expect(rowOf(poison)).toMatchObject({ retry: 2, next_attempt: at(40_000) })

    await runAt(worker, 45_000)
    expect(rowOf(poison)).toMatchObject({
      status: 'manual',
      failure_kind: 'bad_output',
      reject_reason: '审核失败: Moderation verdict is not valid JSON: 好的'
    })
    expect(worker.breakers.text.snapshot().state).toBe('closed')
  })

  // 上线的配置: 系统性故障检测只记日志。它分不清「模型整体坏了」与「连着来了几条
  // 模型答不好的内容」, 所以不让它暂停车道
  it('没有任何成功、5 条不同任务都输出异常: 只记一行疑似的日志, 车道不打开, 照旧逐条扣重试', async () => {
    const worker = newWorker()
    const tasks = Array.from({ length: 7 }, () => addTask())
    failAll(badOutput)

    await runAt(worker, 0)

    expect(worker.breakers.text.snapshot().state).toBe('closed')
    expect(breakerLogs()).toEqual([
      {
        lane: 'text',
        type: 'systematic_suspected',
        tasks: 5,
        lastError: 'Moderation verdict is not valid JSON: 好的'
      }
    ])
    expect(tasks.map((task) => rowOf(task).retry)).toEqual([
      1, 1, 1, 1, 1, 1, 1
    ])
    expect(modelCalledFor()).toHaveLength(7)
  })

  // 'enforce' 时的走向 (没有上线): 模型在答复, 但没有一条处理得成
  it("系统性检测为 'enforce' 时: 车道打开, 之后的任务留在队列里等探测", async () => {
    const worker = newWorker('enforce')
    const tasks = Array.from({ length: 7 }, () => addTask())
    failAll(badOutput)

    await runAt(worker, 0)

    expect(worker.breakers.text.snapshot()).toMatchObject({
      state: 'open',
      reason: 'systematic',
      openUntil: at(30_000).getTime()
    })
    // 同时在途的 5 条各扣一次重试 (它们失败时车道还闭合着); 第 5 条把车道打开, 不早于
    // 下一次探测再试; 后两条没有被认领
    expect(tasks.map((task) => rowOf(task).retry)).toEqual([
      1, 1, 1, 1, 1, 0, 0
    ])
    expect(rowOf(tasks[4]).next_attempt).toEqual(at(30_000))
    expect(modelCalledFor()).toHaveLength(MODERATION_CONCURRENCY)
    expect(claimsOf(tasks[5])).toEqual([])

    // 探测: 输出仍然是坏的 → 重新打开, 探测的那一条不扣
    await runAt(worker, 30_000)
    expect(modelCalledFor()).toEqual([tasks[5].id])
    expect(worker.breakers.text.snapshot()).toMatchObject({
      state: 'open',
      reason: 'systematic',
      opens: 2
    })
    expect(rowOf(tasks[5])).toMatchObject({
      status: 'pending',
      retry: 0,
      defer_count: 0,
      next_attempt: at(90_000)
    })

    // 模型恢复: 探测成功即闭合, 积压的任务照常处理完, 没有一条转人工
    recover()
    await runAt(worker, 90_000)
    expect(modelCalledFor()).toEqual([tasks[6].id])
    expect(worker.breakers.text.snapshot().state).toBe('closed')
    await runAt(worker, 105_000)
    expect(rows.every((row) => row.status === 'approved')).toBe(true)
    expect(markTaskManualMock).not.toHaveBeenCalled()
  })

  it('没带范围的错误 (渲染、落库) 算内部错误, 同样扣重试预算', async () => {
    const worker = newWorker()
    const task = addTask()
    failAll(() => new Error('deadlock detected'))

    await runAt(worker, 0)

    expect(rowOf(task)).toMatchObject({
      retry: 1,
      defer_count: 0,
      failure_kind: 'internal'
    })
  })

  it('内部错误转人工时, 原因里留着错误的类名', async () => {
    const worker = newWorker()
    const task = addTask({ retry: 2 })
    failAll(() => new TypeError('x is not a function'))

    await runAt(worker, 0)

    expect(markTaskManualMock).toHaveBeenCalledWith(task.id, {
      kind: 'internal',
      reason: '审核失败: TypeError: x is not a function'
    })
  })

  it('只有它每次都超时: 推迟预算用完后转人工, 期间正常任务照常通过', async () => {
    const worker = newWorker()
    const poison = addTask({ defer_count: 4 })
    failOnly([poison], () => httpFailure(504))

    await runAt(worker, 0)
    expect(rowOf(poison)).toMatchObject({
      status: 'pending',
      defer_count: 5,
      retry: 0,
      next_attempt: at(600_000)
    })

    const healthy = addTask({ next_attempt: at(600_000) })
    await runAt(worker, 600_000)
    expect(rowOf(poison)).toMatchObject({
      status: 'manual',
      failure_kind: 'deferral_exhausted',
      reject_reason:
        '依赖类失败已推迟 5 次仍未成功: Moderation AI request failed with status 504'
    })
    expect(rowOf(healthy).status).toBe('approved')
    expect(worker.breakers.text.snapshot().state).toBe('closed')
  })

  it('这一类模型没配: 直接转人工, 不进熔断器', async () => {
    const worker = newWorker()
    const tasks = Array.from({ length: 6 }, () => addTask())
    failAll(
      () =>
        new ModerationConfigError('MODERATION_AI_TEXT_MODEL is not configured')
    )

    await runAt(worker, 0)

    expect(tasks.map((task) => rowOf(task))).toEqual(
      tasks.map(() =>
        expect.objectContaining({
          status: 'manual',
          failure_kind: 'misconfigured',
          reject_reason: 'MODERATION_AI_TEXT_MODEL is not configured'
        })
      )
    )
    expect(worker.breakers.text.snapshot().state).toBe('closed')
    expect(breakerLogs()).toEqual([])
  })
})

describe('头像车道', () => {
  it('取图失败算存储的依赖类失败, 只打开头像车道', async () => {
    const worker = newWorker()
    // 各属不同用户: 同一用户的头像任务是串行的
    const avatars = Array.from({ length: 3 }, (_, index) =>
      addAvatarTask({ user_id: 100 + index })
    )
    const comment = addTask()
    getFileFromS3Mock.mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), {
        $fault: 'server',
        $metadata: { httpStatusCode: 503 }
      })
    )

    await runAt(worker, 0)

    expect(worker.breakers.avatar.snapshot()).toMatchObject({
      state: 'open',
      reason: 'dependency'
    })
    expect(worker.breakers.text.snapshot().state).toBe('closed')
    expect(avatars.map((task) => rowOf(task))).toEqual(
      avatars.map(() =>
        expect.objectContaining({
          status: 'pending',
          retry: 0,
          defer_count: 1,
          failure_kind: 'unavailable'
        })
      )
    )
    expect(rowOf(comment).status).toBe('approved')
    expect(moderateImageMock).not.toHaveBeenCalled()
  })

  // 不配视觉模型是有意的部署方式。这类任务注定转人工; 若还去取图, 存储的偶发失败会
  // 记到头像车道头上, 而它永远等不到一次成功来复位
  it('没配视觉模型: 直接转人工, 不碰存储, 存储出问题也不会把车道打开', async () => {
    vi.stubEnv('MODERATION_AI_VISION_MODEL', '')
    const worker = newWorker()
    const avatars = Array.from({ length: 4 }, (_, index) =>
      addAvatarTask({ user_id: 300 + index })
    )
    getFileFromS3Mock.mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), {
        $fault: 'server',
        $metadata: { httpStatusCode: 503 }
      })
    )

    await runAt(worker, 0)

    expect(getFileFromS3Mock).not.toHaveBeenCalled()
    expect(avatars.map((task) => rowOf(task))).toEqual(
      avatars.map(() =>
        expect.objectContaining({
          status: 'manual',
          failure_kind: 'misconfigured',
          reject_reason: 'MODERATION_AI_VISION_MODEL is not configured'
        })
      )
    )
    expect(worker.breakers.avatar.snapshot().state).toBe('closed')
  })

  it('这张图在存储里不存在: 是这一条自己的问题, 扣重试预算, 车道不打开', async () => {
    const worker = newWorker()
    const avatar = addAvatarTask()
    getFileFromS3Mock.mockRejectedValue(
      Object.assign(new Error('NoSuchKey'), {
        $fault: 'client',
        $metadata: { httpStatusCode: 404 }
      })
    )

    await runAt(worker, 0)

    expect(rowOf(avatar)).toMatchObject({
      retry: 1,
      defer_count: 0,
      failure_kind: 'bad_output'
    })
    expect(worker.breakers.avatar.snapshot().state).toBe('closed')
  })
})
