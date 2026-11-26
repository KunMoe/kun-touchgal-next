import { prisma } from '~/prisma'
import { kunLog } from '~/lib/log.server'
import { getMeiliClient } from '~/lib/meilisearch'
import { getKvHashAll, setKvHashFields } from '~/lib/redis'
import {
  SEARCH_COUNT_FIELDS,
  type GalgameSearchCountsDoc
} from '~/server/search/document'
import { defineScheduledJob } from '~/server/jobs/registry'
import { withSearchWriter, type SearchWriter } from '~/server/search/sync'

const COUNTS_REFRESH_BATCH_SIZE = 2000
const COUNTS_SNAPSHOT_KEY = 'search:counts:fp'
// 与每分钟的 drain 同一秒触发、抢同一把写锁：等它放锁，drain 每分钟至多持锁约 50 秒 (积压时
// 最后一行的任务等待还可能多出 30 秒)
const COUNTS_REFRESH_LOCK_WAIT_MS = 90_000

// 指纹覆盖全部会刷入 Meili 的数值字段：任一变化都会触发该行重推。字段与顺序取自
// SEARCH_COUNT_FIELDS，拼出的串与改造前逐个手写的相同，Redis 里已有的快照照常可用
export const countsFingerprint = (doc: GalgameSearchCountsDoc) =>
  SEARCH_COUNT_FIELDS.map((field) => doc[field]).join('|')

// view/download 等计数只影响排序 (以及 ratingCount 过滤)，变化不触发实时同步；本任务分批读全表，
// 仅将指纹相较 Redis 快照发生变化的行以 partial update（PUT）刷入 Meili，
// 未变的长尾静态行不重推，消除对 Meili 的周期性写放大。
// 快照纯为优化：Meili 写成功后才更新，故快照丢失只会导致一次全量重推、绝不漏推。
// 出箱里还挂着行的 id 由 applyCounts 剔除，不写快照，下一轮照旧比对。
// 已删除 patch 会在快照里残留死字段：不被任何现存行的 diff 命中、无正确性影响，
// 仅极缓慢占用内存（每条数十字节）；确需回收时整键删除 COUNTS_SNAPSHOT_KEY 即可。
// 写锁丢失或关停 (writer.signal 中止) 时停在两批之间, 剩下的行等下一轮
export const refreshSearchCounts = async ({
  signal,
  progress,
  applyCounts
}: SearchWriter) => {
  const snapshot = await getKvHashAll(COUNTS_SNAPSHOT_KEY)

  let lastId = 0
  for (; ; progress()) {
    signal.throwIfAborted()
    const rows = await prisma.patch.findMany({
      where: { id: { gt: lastId } },
      orderBy: { id: 'asc' },
      take: COUNTS_REFRESH_BATCH_SIZE,
      select: {
        id: true,
        view: true,
        download: true,
        favorite_count: true,
        resource_count: true,
        comment_count: true,
        rating_stat: { select: { avg_overall: true, count: true } }
      }
    })
    if (rows.length === 0) {
      break
    }

    const changedDocs: GalgameSearchCountsDoc[] = []
    for (const row of rows) {
      const doc: GalgameSearchCountsDoc = {
        id: row.id,
        view: row.view,
        download: row.download,
        favoriteCount: row.favorite_count,
        resourceCount: row.resource_count,
        commentCount: row.comment_count,
        ratingCount: row.rating_stat?.count ?? 0,
        avgRating: row.rating_stat?.avg_overall ?? 0
      }
      if (snapshot[String(row.id)] !== countsFingerprint(doc)) {
        changedDocs.push(doc)
      }
    }

    lastId = rows[rows.length - 1].id

    const applied = await applyCounts(changedDocs)
    if (applied.length > 0) {
      await setKvHashFields(
        COUNTS_SNAPSHOT_KEY,
        Object.fromEntries(
          applied.map((doc) => [String(doc.id), countsFingerprint(doc)])
        )
      )
    }
  }
}

// 与出箱的 drain 共用写锁：持锁期间 drain 不运行。锁被占着时等一会儿，等不到才本轮跳过
// (30 分钟后再来)，跳过要留日志：索引里的计数会因此多陈旧 30 分钟
export const searchCountsRefreshJob = defineScheduledJob({
  name: 'search_counts_refresh',
  schedule: '*/30 * * * *',
  run: async ({ signal }) => {
    if (!getMeiliClient()) {
      return
    }
    const ran = await withSearchWriter(
      'searchCountsRefreshTask',
      async (writer) => {
        await refreshSearchCounts(writer)
        return true
      },
      { waitMs: COUNTS_REFRESH_LOCK_WAIT_MS, signal }
    )
    // 关停时不再等锁, 那不是「没等到」
    if (!ran && !signal.aborted) {
      kunLog('search.counts_refresh_skipped', {
        waitSec: COUNTS_REFRESH_LOCK_WAIT_MS / 1000
      })
    }
  }
})
