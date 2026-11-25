import { startJobRuntime } from './jobs/registry'
import type { JobRuntime } from './jobs/registry'
import { flushPatchViewsJob } from './tasks/flushPatchViewsTask'
import { mailCampaignJob } from './tasks/mailCampaignTask'
import { moderationJob } from './tasks/moderationTask'
import { resetDailyJob } from './tasks/resetDailyTask'
import { s3DeletionOutboxJob } from './tasks/s3DeletionOutboxTask'
import { searchCountsRefreshJob } from './tasks/searchCountsRefreshTask'
import { searchOutboxJob } from './tasks/searchOutboxTask'
import { searchReconcileJob } from './tasks/searchReconcileTask'

// cron 进程里的全部定时作业 (只在 KUN_ENABLE_CRON=true 的进程里启动, 见 instrumentation.ts)
export const KUN_JOBS = [
  resetDailyJob,
  flushPatchViewsJob,
  moderationJob,
  searchOutboxJob,
  searchCountsRefreshJob,
  searchReconcileJob,
  s3DeletionOutboxJob,
  mailCampaignJob
]

// 关停的宽限期: 收到信号后等在途作业这么久, 再中止它们的在途调用 (再留 JOB_CANCEL_SETTLE_MS
// 收尾)。两者之和必须小于 ecosystem.config.cjs 里 cron 进程的 kill_timeout, 否则 PM2 先发
// SIGKILL (server/__tests__/cron.test.ts 钉住)
export const KUN_JOB_SHUTDOWN_GRACE_MS = 20_000

const globalJobState = globalThis as typeof globalThis & {
  __kunJobRuntime?: Promise<JobRuntime>
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

// 每个进程只启动一次: 重复调用拿到同一个运行时, 启动失败后可以重试
export const startKunJobs = () => {
  globalJobState.__kunJobRuntime ??= (async () => {
    const runtime = await startJobRuntime(KUN_JOBS)
    void checkSearchIndexOnStartup().catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[kun-search] 启动时比对索引定义失败:', error)
    })
    return runtime
  })().catch((error) => {
    globalJobState.__kunJobRuntime = undefined
    throw error
  })
  return globalJobState.__kunJobRuntime
}

// 收到 SIGINT / SIGTERM 时先优雅关停作业再退出。只有 Next 不接管信号时 (cron 进程的
// NEXT_MANUAL_SIG_HANDLE) 才真正等得到: 否则 Next 关掉 HTTP 就直接退出进程。退出码与 Next 的
// 约定一致 (128 + 信号编号)。用 on 不用 once: once 在调用之前就移除了监听, 之后注册的
// signal-exit 一类监听会以为自己是最后一个、重发信号, 按默认行为立即杀掉进程。关停期间再收到
// 信号 (操作者第二次 Ctrl-C) 立即退出
export const handleKunJobShutdownSignals = (runtime: JobRuntime) => {
  let stopping = false
  const shutdown = (signal: NodeJS.Signals) => {
    const code = signal === 'SIGINT' ? 130 : 143
    if (stopping) {
      process.exit(code)
      return
    }
    stopping = true
    // eslint-disable-next-line no-console
    console.log(`[kun-jobs] 收到 ${signal}, 关停作业后退出`)
    void runtime
      .stop(KUN_JOB_SHUTDOWN_GRACE_MS)
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[kun-jobs] 关停作业失败:', error)
      })
      .finally(() => process.exit(code))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
