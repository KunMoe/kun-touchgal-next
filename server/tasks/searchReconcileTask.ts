import { getMeiliClient } from '~/lib/meilisearch'
import { defineScheduledJob } from '~/server/jobs/registry'
import { reconcileSearchIndex } from '~/server/search/reconcile'

export const searchReconcileJob = defineScheduledJob({
  name: 'search_reconcile',
  schedule: '0 5 * * *',
  // 对账不报进度 (整次检测是一个工作单元): 停滞上限沿用改造前这把锁的寿命, 一小时
  lease: { key: 'search:reconcile:lock', stallMs: 60 * 60 * 1000 },
  run: async () => {
    if (!getMeiliClient()) {
      return
    }
    // 只检测、只入箱，写入由出箱的 drain 完成 (cron 每分钟一轮)
    const result = await reconcileSearchIndex()
    console.log(
      `搜索索引对账完成: PG 共 ${result.total} 条，入箱 缺失 ${result.missing} / 多余 ${result.extra} / 过时 ${result.stale} 条`
    )
  }
})
