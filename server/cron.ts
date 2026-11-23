import type { ScheduledTask } from 'node-cron'

const globalTaskState = globalThis as typeof globalThis & {
  __kunGalgameTasksStarted?: boolean
  __kunGalgameTasksStarting?: Promise<void>
}

const getKUNGalgameTasks = async (): Promise<ScheduledTask[]> => {
  const [
    { resetDailyTask },
    { flushPatchViewsTask },
    { moderationTask },
    { searchOutboxTask },
    { searchCountsRefreshTask },
    { searchReconcileTask },
    { s3DeletionOutboxTask },
    { mailCampaignTask }
  ] = await Promise.all([
    import('./tasks/resetDailyTask'),
    import('./tasks/flushPatchViewsTask'),
    import('./tasks/moderationTask'),
    import('./tasks/searchOutboxTask'),
    import('./tasks/searchCountsRefreshTask'),
    import('./tasks/searchReconcileTask'),
    import('./tasks/s3DeletionOutboxTask'),
    import('./tasks/mailCampaignTask')
  ])

  return [
    resetDailyTask,
    flushPatchViewsTask,
    moderationTask,
    searchOutboxTask,
    searchCountsRefreshTask,
    searchReconcileTask,
    s3DeletionOutboxTask,
    mailCampaignTask
  ]
}

// 启动时只读比对一次线上索引定义：部署链的 search:ensure 没跑成、有人手改了线上 settings、
// 或这次部署走的还是旧的部署链 (deployBuild.ts 在 git pull 之前就已加载) 时，在这里留一条 error。
// 只有收缩 (线上多出新代码不再用的字段) 时记 warn：切换时 cron 先重启，部署链的 post 阶段在
// 几秒之后才下发收缩，每次带收缩的部署都会先看到它，而多出来的字段对新代码无害
export const checkSearchIndexOnStartup = async () => {
  const { ensureSearchIndex } = await import('./search/indexAdmin')
  const report = await ensureSearchIndex({ mode: 'check' })
  if (!report || (!report.missing && report.diffs.length === 0)) {
    return
  }
  const onlyContract =
    !report.missing && report.diffs.every(({ kind }) => kind === 'contract')
  // eslint-disable-next-line no-console
  const log = onlyContract ? console.warn : console.error
  log(
    '[kun-search] 线上索引的定义与代码不一致, 跑 pnpm search:ensure --check 查看、pnpm search:ensure --apply 下发:',
    report.missing
      ? '索引不存在'
      : report.diffs.map(({ key, kind }) => `${key} (${kind})`).join(', ')
  )
}

export const setKUNGalgameTask = async () => {
  if (globalTaskState.__kunGalgameTasksStarted) {
    return
  }

  if (globalTaskState.__kunGalgameTasksStarting) {
    await globalTaskState.__kunGalgameTasksStarting
    return
  }

  const startingTask = (async () => {
    const tasks = await getKUNGalgameTasks()
    await Promise.all(tasks.map((task) => task.start()))
    globalTaskState.__kunGalgameTasksStarted = true
    void checkSearchIndexOnStartup().catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[kun-search] 启动时比对索引定义失败:', error)
    })
  })()

  globalTaskState.__kunGalgameTasksStarting = startingTask

  try {
    await startingTask
  } catch (error) {
    globalTaskState.__kunGalgameTasksStarted = false
    throw error
  } finally {
    if (globalTaskState.__kunGalgameTasksStarting === startingTask) {
      globalTaskState.__kunGalgameTasksStarting = undefined
    }
  }
}
