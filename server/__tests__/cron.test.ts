import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureSearchIndexMock } = vi.hoisted(() => ({
  ensureSearchIndexMock: vi.fn()
}))

vi.mock('~/server/search/indexAdmin', () => ({
  ensureSearchIndex: ensureSearchIndexMock
}))

// 各定时任务只需要能 start
const { taskStartMock } = vi.hoisted(() => ({ taskStartMock: vi.fn() }))
const task = () => ({ start: taskStartMock })
vi.mock('~/server/tasks/resetDailyTask', () => ({ resetDailyTask: task() }))
vi.mock('~/server/tasks/flushPatchViewsTask', () => ({
  flushPatchViewsTask: task()
}))
vi.mock('~/server/tasks/moderationTask', () => ({ moderationTask: task() }))
vi.mock('~/server/tasks/searchOutboxTask', () => ({
  searchOutboxTask: task()
}))
vi.mock('~/server/tasks/searchCountsRefreshTask', () => ({
  searchCountsRefreshTask: task()
}))
vi.mock('~/server/tasks/searchReconcileTask', () => ({
  searchReconcileTask: task()
}))
vi.mock('~/server/tasks/s3DeletionOutboxTask', () => ({
  s3DeletionOutboxTask: task()
}))
vi.mock('~/server/tasks/mailCampaignTask', () => ({
  mailCampaignTask: task()
}))

import { checkSearchIndexOnStartup, setKUNGalgameTask } from '~/server/cron'

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

  it('启动定时任务时调用一次', async () => {
    ensureSearchIndexMock.mockResolvedValue(report())

    await setKUNGalgameTask()
    await vi.waitFor(() =>
      expect(ensureSearchIndexMock).toHaveBeenCalledWith({ mode: 'check' })
    )
    expect(taskStartMock).toHaveBeenCalledTimes(8)
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
