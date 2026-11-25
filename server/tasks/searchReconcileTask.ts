import { getMeiliClient } from '~/lib/meilisearch'
import { defineScheduledJob } from '~/server/jobs/registry'
import { reconcileSearchIndex } from '~/server/search/reconcile'
import { withTaskLock } from './withTaskLock'

const SEARCH_RECONCILE_LOCK_KEY = 'search:reconcile:lock'
const SEARCH_RECONCILE_LOCK_TTL_SECONDS = 3600

export const searchReconcileJob = defineScheduledJob({
  name: 'search_reconcile',
  schedule: '0 5 * * *',
  run: async () => {
    if (!getMeiliClient()) {
      return
    }

    await withTaskLock(
      {
        key: SEARCH_RECONCILE_LOCK_KEY,
        ttlSeconds: SEARCH_RECONCILE_LOCK_TTL_SECONDS,
        taskName: 'searchReconcileTask'
      },
      async () => {
        // 只检测、只入箱，写入由出箱的 drain 完成 (cron 每分钟一轮)
        const result = await reconcileSearchIndex()
        console.log(
          `搜索索引对账完成: PG 共 ${result.total} 条，入箱 缺失 ${result.missing} / 多余 ${result.extra} / 过时 ${result.stale} 条`
        )
      }
    )
  }
})
