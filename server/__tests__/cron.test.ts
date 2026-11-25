import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureSearchIndexMock } = vi.hoisted(() => ({
  ensureSearchIndexMock: vi.fn()
}))

vi.mock('~/server/search/indexAdmin', () => ({
  ensureSearchIndex: ensureSearchIndexMock
}))

const { startJobRuntimeMock, stopMock } = vi.hoisted(() => ({
  startJobRuntimeMock: vi.fn(),
  stopMock: vi.fn()
}))
vi.mock('~/server/jobs/registry', () => ({
  startJobRuntime: startJobRuntimeMock,
  JOB_CANCEL_SETTLE_MS: 5_000
}))

// 各作业的 spec 只看名字 (server/cron.ts 静态导入它们, 须在 hoisted 里定义)
const { job } = vi.hoisted(() => ({ job: (name: string) => ({ name }) }))
vi.mock('~/server/tasks/resetDailyTask', () => ({
  resetDailyJob: job('reset_daily')
}))
vi.mock('~/server/tasks/flushPatchViewsTask', () => ({
  flushPatchViewsJob: job('flush_patch_views')
}))
vi.mock('~/server/tasks/moderationTask', () => ({
  moderationJob: job('moderation')
}))
vi.mock('~/server/tasks/searchOutboxTask', () => ({
  searchOutboxJob: job('search_outbox')
}))
vi.mock('~/server/tasks/searchCountsRefreshTask', () => ({
  searchCountsRefreshJob: job('search_counts_refresh')
}))
vi.mock('~/server/tasks/searchReconcileTask', () => ({
  searchReconcileJob: job('search_reconcile')
}))
vi.mock('~/server/tasks/s3DeletionOutboxTask', () => ({
  s3DeletionOutboxJob: job('s3_deletion_outbox')
}))
vi.mock('~/server/tasks/mailCampaignTask', () => ({
  mailCampaignJob: job('mail_campaign')
}))

import { createRequire } from 'node:module'
import { JOB_CANCEL_SETTLE_MS } from '~/server/jobs/registry'
import {
  KUN_JOB_SHUTDOWN_GRACE_MS,
  checkSearchIndexOnStartup,
  handleKunJobShutdownSignals,
  startKunJobs
} from '~/server/cron'

const report = (overrides: Record<string, unknown> = {}) => ({
  created: false,
  missing: false,
  diffs: [],
  applied: [],
  patchCount: 1,
  maxTotalHits: 20000,
  ...overrides
})

describe('checkSearchIndexOnStartup 启动时只读比对索引定义', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    ensureSearchIndexMock.mockReset()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('启动作业运行时之后调用一次; 重复启动拿到同一个运行时', async () => {
    ensureSearchIndexMock.mockResolvedValue(report())
    startJobRuntimeMock.mockResolvedValue({ stop: stopMock })

    const runtime = await startKunJobs()
    await vi.waitFor(() =>
      expect(ensureSearchIndexMock).toHaveBeenCalledWith({ mode: 'check' })
    )
    expect(startJobRuntimeMock).toHaveBeenCalledOnce()
    expect(startJobRuntimeMock.mock.calls[0][0]).toHaveLength(8)
    // 与生产服务器一致的 UTC+8: 每日重置在 0 点、对账在 5 点, 不随进程的 TZ 变
    expect(startJobRuntimeMock.mock.calls[0][1]).toEqual({
      timezone: 'Asia/Singapore'
    })

    await expect(startKunJobs()).resolves.toBe(runtime)
    expect(startJobRuntimeMock).toHaveBeenCalledOnce()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('只用 check 模式, 定义一致时不记日志', async () => {
    ensureSearchIndexMock.mockResolvedValue(report())

    await checkSearchIndexOnStartup()

    expect(ensureSearchIndexMock).toHaveBeenCalledWith({ mode: 'check' })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('有差异时记一条 error, 列出键与种类', async () => {
    ensureSearchIndexMock.mockResolvedValue(
      report({
        diffs: [
          { key: 'sortableAttributes', kind: 'expand' },
          { key: 'rankingRules', kind: 'change' }
        ]
      })
    )

    await checkSearchIndexOnStartup()

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('pnpm search:ensure --apply'),
      'sortableAttributes (expand), rankingRules (change)'
    )
  })

  it('只有收缩 (等部署链的 post 阶段下发) 时记 warn, 不记 error', async () => {
    ensureSearchIndexMock.mockResolvedValue(
      report({ diffs: [{ key: 'filterableAttributes', kind: 'contract' }] })
    )

    await checkSearchIndexOnStartup()

    expect(errorSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.any(String),
      'filterableAttributes (contract)'
    )
  })

  it('索引不存在时同样记 error', async () => {
    ensureSearchIndexMock.mockResolvedValue(report({ missing: true }))

    await checkSearchIndexOnStartup()

    expect(errorSpy).toHaveBeenCalledWith(expect.any(String), '索引不存在')
  })

  it('未配置 Meilisearch 时什么都不记', async () => {
    ensureSearchIndexMock.mockResolvedValue(null)

    await checkSearchIndexOnStartup()

    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('关停契约', () => {
  interface PmApp {
    name: string
    kill_timeout?: number
    env: Record<string, unknown>
  }
  const { apps } = createRequire(import.meta.url)(
    '../../ecosystem.config.cjs'
  ) as { apps: PmApp[] }
  const appOf = (name: string) => apps.find((app) => app.name === name)!

  // PM2 停进程先发 SIGINT, 过了 kill_timeout 还没退出就 SIGKILL: 宽限期加收尾必须在它之内
  it('cron 进程的 kill_timeout 容得下作业的宽限期与收尾', () => {
    expect(appOf('kun-touchgal-next-cron').kill_timeout).toBeGreaterThan(
      KUN_JOB_SHUTDOWN_GRACE_MS + JOB_CANCEL_SETTLE_MS
    )
  })

  // web 进程设了它, Next 不再在收到信号时关 HTTP
  it('只有 cron 进程把信号交给作业层', () => {
    expect(appOf('kun-touchgal-next-cron').env.NEXT_MANUAL_SIG_HANDLE).toBe(
      'true'
    )
    expect(appOf('kun-touchgal-next').env).not.toHaveProperty(
      'NEXT_MANUAL_SIG_HANDLE'
    )
  })

  it('收到信号先关停作业再退出, 退出码为 128 + 信号编号', async () => {
    const handlers = new Map<string, (signal: NodeJS.Signals) => void>()
    // 用 on 不用 once (见 handleKunJobShutdownSignals 的注释)
    const on = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: () => void
    ) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { promise: stopped, resolve: finishStop } =
      Promise.withResolvers<void>()
    stopMock.mockReset().mockReturnValue(stopped)

    handleKunJobShutdownSignals({ stop: stopMock })
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM'])

    handlers.get('SIGTERM')!('SIGTERM')
    expect(stopMock).toHaveBeenCalledExactlyOnceWith(KUN_JOB_SHUTDOWN_GRACE_MS)
    await Promise.resolve()
    expect(exit).not.toHaveBeenCalled()

    finishStop()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(143))
    on.mockRestore()
    exit.mockRestore()
  })

  it('关停期间再收到信号: 立即退出, 不再等作业', async () => {
    const handlers = new Map<string, (signal: NodeJS.Signals) => void>()
    const on = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: () => void
    ) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    stopMock.mockReset().mockReturnValue(new Promise(() => {}))

    handleKunJobShutdownSignals({ stop: stopMock })
    handlers.get('SIGINT')!('SIGINT')
    expect(exit).not.toHaveBeenCalled()
    handlers.get('SIGINT')!('SIGINT')

    expect(exit).toHaveBeenCalledExactlyOnceWith(130)
    expect(stopMock).toHaveBeenCalledOnce()
    on.mockRestore()
    exit.mockRestore()
  })
})
