import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { moderation_taskModel } from '~/prisma/generated/prisma/models'
import {
  MODERATION_BATCH_SIZE,
  MODERATION_CONCURRENCY,
  MODERATION_LEASE_SECONDS
} from '~/constants/moderation'

// 批次与失败记账: 取哪些任务、怎么认领、失败算在谁头上。单条任务内部 (黑名单、缓存、
// 送审视图) 由 moderationTask.test.ts 覆盖

const {
  findTasksMock,
  updateTaskMock,
  findBlacklistMock,
  getKvMock,
  setKvMock,
  moderateTextMock,
  applyModerationVerdictMock,
  markTaskManualMock
} = vi.hoisted(() => ({
  findTasksMock: vi.fn(),
  updateTaskMock: vi.fn(),
  findBlacklistMock: vi.fn(),
  getKvMock: vi.fn(),
  setKvMock: vi.fn(),
  moderateTextMock: vi.fn(),
  applyModerationVerdictMock: vi.fn(),
  markTaskManualMock: vi.fn()
}))

vi.mock('node-cron', () => ({ default: { createTask: vi.fn() } }))
vi.mock('sharp', () => ({ default: vi.fn() }))
vi.mock('~/prisma', () => ({
  prisma: {
    moderation_task: { findMany: findTasksMock, updateMany: updateTaskMock },
    moderation_blacklist: { findMany: findBlacklistMock }
  }
}))
vi.mock('~/lib/redis', () => ({ getKv: getKvMock, setKv: setKvMock }))
vi.mock('~/lib/s3', () => ({ getFileFromS3: vi.fn() }))
vi.mock('~/server/image/encodeLimit', () => ({ withEncodeSlot: vi.fn() }))
vi.mock('~/server/tasks/withTaskLock', () => ({ withTaskLock: vi.fn() }))
vi.mock('~/server/moderation/apply', () => ({
  applyModerationVerdict: applyModerationVerdictMock,
  markTaskManual: markTaskManualMock
}))
vi.mock(import('~/server/moderation/ai'), async (importOriginal) => ({
  ...(await importOriginal()),
  moderateText: moderateTextMock,
  moderateImage: vi.fn()
}))

import { ModerationConfigError } from '~/server/moderation/ai'
import { runModerationBatch } from '~/server/tasks/moderationTask'

const NOW = new Date('2026-11-20T12:00:00.000Z')

let nextTaskId = 1
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

// 每条任务的正文各不相同, 模型的 mock 靠它认出是哪一条
const textOf = (taskId: number) => `评论 #${taskId}#`

// 评论各自成组 (全并发); plain 段不经渲染管线
const makeTask = (
  overrides: Partial<moderation_taskModel> = {}
): moderation_taskModel => {
  const id = nextTaskId++
  return {
    id,
    content_type: 'comment',
    content_id: 10,
    patch_id: null,
    user_id: 7,
    payload: {
      v: 2,
      segments: [{ label: '评论', kind: 'plain', value: textOf(id) }]
    },
    retry: 0,
    picked_at: null,
    dry_run: false,
    ...overrides
  } as moderation_taskModel
}

type UpdateArgs = {
  where: Record<string, unknown>
  data: Record<string, unknown>
}

const updateCalls = () =>
  updateTaskMock.mock.calls.map(([args]) => args as UpdateArgs)

// 认领写入带一个新的租约时间戳; 退避写入把租约清空
const claimsOf = (taskId: number) =>
  updateCalls().filter(
    ({ where, data }) => where.id === taskId && data.picked_at instanceof Date
  )

const backoffsOf = (taskId: number) =>
  updateCalls().filter(
    ({ where, data }) => where.id === taskId && data.picked_at === null
  )

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.resetAllMocks()
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  nextTaskId = 1
  findTasksMock.mockResolvedValue([])
  findBlacklistMock.mockResolvedValue([])
  updateTaskMock.mockResolvedValue({ count: 1 })
  getKvMock.mockResolvedValue(null)
  setKvMock.mockResolvedValue(undefined)
  moderateTextMock.mockResolvedValue({
    verdict: { pass: true },
    model: 'test-model',
    tokensIn: 1,
    tokensOut: 1
  })
  applyModerationVerdictMock.mockResolvedValue(true)
  markTaskManualMock.mockResolvedValue({ count: 1 })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('取任务', () => {
  it('只取待处理、已到重试时刻、租约为空或已过期的任务, 按就绪时刻先后取一批', async () => {
    await runModerationBatch()

    expect(findTasksMock).toHaveBeenCalledTimes(1)
    expect(findTasksMock).toHaveBeenCalledWith({
      where: {
        status: 'pending',
        next_attempt: { lte: NOW },
        OR: [
          { picked_at: null },
          {
            picked_at: {
              lt: new Date(NOW.getTime() - MODERATION_LEASE_SECONDS * 1000)
            }
          }
        ]
      },
      orderBy: { next_attempt: 'asc' },
      take: MODERATION_BATCH_SIZE
    })
    expect(updateTaskMock).not.toHaveBeenCalled()
  })
})

describe('认领', () => {
  it('调模型之前先给这一行盖租约, 认领条件与取任务的谓词相同', async () => {
    const task = makeTask()
    findTasksMock.mockResolvedValue([task])

    await runModerationBatch()

    expect(claimsOf(task.id)).toEqual([
      {
        where: {
          id: task.id,
          status: 'pending',
          next_attempt: { lte: NOW },
          OR: [
            { picked_at: null },
            {
              picked_at: {
                lt: new Date(NOW.getTime() - MODERATION_LEASE_SECONDS * 1000)
              }
            }
          ]
        },
        data: { picked_at: NOW }
      }
    ])
    expect(moderateTextMock).toHaveBeenCalledTimes(1)
    expect(applyModerationVerdictMock).toHaveBeenCalledTimes(1)
    expect(backoffsOf(task.id)).toEqual([])
    expect(markTaskManualMock).not.toHaveBeenCalled()
  })

  it('没抢到 (另一个 worker 已认领) 就跳过, 不调模型也不记账', async () => {
    const task = makeTask()
    findTasksMock.mockResolvedValue([task])
    updateTaskMock.mockResolvedValue({ count: 0 })

    await runModerationBatch()

    expect(updateTaskMock).toHaveBeenCalledTimes(1)
    expect(moderateTextMock).not.toHaveBeenCalled()
    expect(applyModerationVerdictMock).not.toHaveBeenCalled()
    expect(markTaskManualMock).not.toHaveBeenCalled()
  })
})

describe('失败记账', () => {
  it('缺模型配置: 不重试, 直接转人工', async () => {
    const task = makeTask()
    findTasksMock.mockResolvedValue([task])
    moderateTextMock.mockRejectedValue(
      new ModerationConfigError('MODERATION_AI_TEXT_MODEL is not configured')
    )

    await runModerationBatch()

    expect(markTaskManualMock).toHaveBeenCalledTimes(1)
    expect(markTaskManualMock).toHaveBeenCalledWith(
      task.id,
      'MODERATION_AI_TEXT_MODEL is not configured'
    )
    expect(backoffsOf(task.id)).toEqual([])
  })

  it.each([
    [0, 1, 5_000],
    [1, 2, 25_000]
  ])(
    '其余错误: 已试 %i 次 → retry 写成 %i, %i 毫秒后再试, 租约清空',
    async (retry, nextRetry, delayMs) => {
      const task = makeTask({ retry })
      findTasksMock.mockResolvedValue([task])
      moderateTextMock.mockRejectedValue(new Error('upstream 503'))

      await runModerationBatch()

      expect(backoffsOf(task.id)).toEqual([
        {
          where: { id: task.id, status: 'pending' },
          data: {
            retry: nextRetry,
            next_attempt: new Date(NOW.getTime() + delayMs),
            picked_at: null
          }
        }
      ])
      expect(markTaskManualMock).not.toHaveBeenCalled()
    }
  )

  it('第三次失败转人工, 原因带上错误原文', async () => {
    const task = makeTask({ retry: 2 })
    findTasksMock.mockResolvedValue([task])
    moderateTextMock.mockRejectedValue(new Error('upstream 503'))

    await runModerationBatch()

    expect(markTaskManualMock).toHaveBeenCalledTimes(1)
    expect(markTaskManualMock).toHaveBeenCalledWith(
      task.id,
      '审核失败: Error: upstream 503'
    )
    expect(backoffsOf(task.id)).toEqual([])
  })
})

// 取到时租约非空, 说明上一个 worker 崩在了半路: 既没落裁决也没写退避
describe('回收过期租约', () => {
  const stale = new Date(NOW.getTime() - (MODERATION_LEASE_SECONDS + 1) * 1000)

  it('认领的同一条语句里把 retry 加一, 然后照常处理', async () => {
    const task = makeTask({ picked_at: stale })
    findTasksMock.mockResolvedValue([task])

    await runModerationBatch()

    expect(claimsOf(task.id).map(({ data }) => data)).toEqual([
      { picked_at: NOW, retry: { increment: 1 } }
    ])
    expect(moderateTextMock).toHaveBeenCalledTimes(1)
    expect(applyModerationVerdictMock).toHaveBeenCalledTimes(1)
  })

  it('回收后又抛错: retry 只净加一 (绝对写, 与认领时的自增落在同一个值)', async () => {
    const task = makeTask({ picked_at: stale })
    findTasksMock.mockResolvedValue([task])
    moderateTextMock.mockRejectedValue(new Error('upstream 503'))

    await runModerationBatch()

    expect(backoffsOf(task.id).map(({ data }) => data)).toEqual([
      {
        retry: 1,
        next_attempt: new Date(NOW.getTime() + 5_000),
        picked_at: null
      }
    ])
  })

  it('回收把预算用完: 转人工, 不再调模型', async () => {
    const task = makeTask({ picked_at: stale, retry: 2 })
    findTasksMock.mockResolvedValue([task])

    await runModerationBatch()

    expect(markTaskManualMock).toHaveBeenCalledTimes(1)
    expect(markTaskManualMock).toHaveBeenCalledWith(
      task.id,
      '多次处理未完成, 已转人工复核'
    )
    expect(moderateTextMock).not.toHaveBeenCalled()
  })
})

describe('并发与分组', () => {
  // 让每次模型调用停在半路, 由测试逐个放行
  const holdModelCalls = () => {
    const releases: Array<() => void> = []
    let inFlight = 0
    let peak = 0
    moderateTextMock.mockImplementation(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      const { promise, resolve } = Promise.withResolvers<void>()
      releases.push(resolve)
      await promise
      inFlight--
      return {
        verdict: { pass: true },
        model: 'test-model',
        tokensIn: 1,
        tokensOut: 1
      }
    })
    return {
      releases,
      peak: () => peak,
      // 让已经能走的微任务都走完: 该发起的调用都已发起, 被挡住的确实没动
      settle: async () => {
        for (let i = 0; i < 20; i++) {
          await Promise.resolve()
        }
      }
    }
  }

  it('同时在途的模型调用不超过并发上限', async () => {
    const tasks = Array.from({ length: MODERATION_CONCURRENCY + 2 }, () =>
      makeTask()
    )
    findTasksMock.mockResolvedValue(tasks)
    const model = holdModelCalls()

    const batch = runModerationBatch()
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

  it('同一个 patch 的资源与评价串行, 同一个用户的头像与签名串行', async () => {
    const plain = (label: string) => ({
      v: 2,
      segments: [{ label, kind: 'plain', value: `${label}内容` }],
      name: 'n',
      bio: 'b'
    })
    const resource = makeTask({
      content_type: 'resource',
      patch_id: 3,
      payload: plain('标题')
    })
    const rating = makeTask({
      content_type: 'rating',
      patch_id: 3,
      payload: plain('评价')
    })
    const otherRating = makeTask({
      content_type: 'rating',
      patch_id: 4,
      payload: plain('评价')
    })
    findTasksMock.mockResolvedValue([resource, rating, otherRating])
    const model = holdModelCalls()

    const batch = runModerationBatch()
    await model.settle()

    // patch 3 的第二条要等第一条结算; patch 4 不受它影响
    expect(moderateTextMock.mock.calls.map(([type]) => type)).toEqual([
      'resource',
      'rating'
    ])
    expect(claimsOf(rating.id)).toEqual([])
    expect(claimsOf(otherRating.id)).toHaveLength(1)

    model.releases.shift()?.()
    await model.settle()
    expect(claimsOf(rating.id)).toHaveLength(1)

    model.releases.forEach((release) => release())
    await batch
    expect(applyModerationVerdictMock).toHaveBeenCalledTimes(3)
  })

  it('一条任务的记账写库失败不影响别的组, 批次等所有 worker 结束才返回', async () => {
    const broken = makeTask()
    const healthy = makeTask()
    findTasksMock.mockResolvedValue([broken, healthy])
    moderateTextMock.mockImplementation(async (_type, message: string) => {
      if (message.includes(textOf(broken.id))) {
        throw new Error('upstream 503')
      }
      return {
        verdict: { pass: true },
        model: 'test-model',
        tokensIn: 1,
        tokensOut: 1
      }
    })
    updateTaskMock.mockImplementation(async ({ data }: UpdateArgs) => {
      if (data.picked_at === null) {
        throw new Error('db down')
      }
      return { count: 1 }
    })

    await expect(runModerationBatch()).resolves.toBeUndefined()

    expect(applyModerationVerdictMock).toHaveBeenCalledTimes(1)
    expect(applyModerationVerdictMock).toHaveBeenCalledWith(
      expect.objectContaining({ task: healthy })
    )
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Moderation worker crashed:',
      expect.objectContaining({ message: 'db down' })
    )
  })
})
