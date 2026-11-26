import 'dotenv/config'
import { parseArgs } from 'util'
import { prisma } from '~/prisma/index'
import { getMeiliClient } from '~/lib/meilisearch'
import { reconcileSearchIndex } from '~/server/search/reconcile'
import {
  drainSearchOutboxUntilEmpty,
  enqueueSearchOutboxBatch,
  getSearchOutboxBacklog
} from '~/server/search/sync'

// 对账：检测索引与 PG 的漂移并入箱 (只读检测，写入只经出箱)。空索引上跑一次就是全量同步。
//   pnpm search:reconcile                  入箱后在本进程里排空出箱 (逐行写入，1.4 万份约 15–30 分钟)
//   pnpm search:reconcile --enqueue-only   只入箱，交给 cron 进程每分钟的 drain
//   pnpm search:reconcile --retry-failed   先把退避中与已隔离的行复位 (修好被拒的原因之后用)
// 本进程排空时与 cron 的 drain 靠 Redis 里的写锁互斥：根目录 .env 的 Redis 地址与前缀要与运行中
// 的进程 (读的是构建时复制进 standalone 的那份) 一致，不确定就用 --enqueue-only
const QUARANTINE_PRINT_LIMIT = 20

const run = async () => {
  const { values } = parseArgs({
    options: {
      'enqueue-only': { type: 'boolean', default: false },
      'retry-failed': { type: 'boolean', default: false }
    }
  })
  if (!getMeiliClient()) {
    console.log('未配置 MEILISEARCH_HOST / MEILISEARCH_ADMIN_API_KEY，跳过对账')
    return
  }

  if (values['retry-failed']) {
    const failedRows = await prisma.search_outbox.findMany({
      where: { attempts: { gt: 0 } },
      select: { patch_id: true }
    })
    // 应用写入的入队模式复位失败记录
    await enqueueSearchOutboxBatch(
      prisma,
      failedRows.map((row) => row.patch_id)
    )
    console.log(`已复位 ${failedRows.length} 行的失败记录`)
  }

  const result = await reconcileSearchIndex()
  console.log(
    `对账完成: PG 共 ${result.total} 条，入箱 缺失 ${result.missing} / 多余 ${result.extra} / 过时 ${result.stale} 条`
  )

  if (!values['enqueue-only']) {
    await drainSearchOutboxUntilEmpty({
      onRound: (round, ready) =>
        console.log(
          round.outcome === 'locked'
            ? `写锁在别的写者手里 (多半是 cron 的 drain)，剩余可取 ${ready} 条`
            : round.outcome === 'engine-unavailable'
              ? `Meilisearch 此刻收不了写入，稍后再试，剩余可取 ${ready} 条`
              : `本轮写入 ${round.synced} 条、被拒 ${round.failed} 条，剩余可取 ${ready} 条`
        )
    })
  }

  const { ready, backoff, quarantined } = await getSearchOutboxBacklog()
  console.log(
    `出箱: 可取 ${ready} 条，退避中 ${backoff} 条，已隔离 ${quarantined.length} 条`
  )
  for (const row of quarantined.slice(0, QUARANTINE_PRINT_LIMIT)) {
    console.warn(`  已隔离 patch ${row.patch_id}: ${row.last_error ?? ''}`)
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
