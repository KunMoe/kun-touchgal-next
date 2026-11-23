import { prisma } from '~/prisma/index'
import { getMeiliClient } from '~/lib/meilisearch'
import { GALGAME_INDEX } from './settings'
import { PATCH_SEARCH_SELECT, patchToSearchDoc } from './document'
import { enqueueSearchOutboxBatch } from './sync'

const RECONCILE_BATCH_SIZE = 1000
// markdown 转换是同步 CPU: 每构建这么多文档就让出一次事件循环, 把突发摊平成协作
// 切片, 避免饿死同 cron 进程的 moderation / retry 等定时任务
const DOC_BUILD_CHUNK_SIZE = 50

export interface SearchDrift {
  // PG 里的 patch 条数
  total: number
  // PG 有、索引没有
  missing: number[]
  // 索引有、PG 没有
  extra: number[]
  // 两边都有, 但索引里的文档摘要与按 PG 现状构建出的不同 (含还没有摘要的旧文档)
  stale: number[]
}

// 检测器: 以 PG 为准比对索引, 全程只读, 不调用任何 Meilisearch 写 API。比的是文档摘要
// (document.ts 的 computeSearchDocHash), 不是 patch.updated: 关联表 (别名、标签、会社) 的写入、
// 标签 / 会社改名、绕过应用层的脚本都不推进 updated, 下载又推进 updated 却不改文档内容。
// 两次扫描之间的写入最多让结果多出几个 id (多入一次箱), 不会让谁被误删: 修回只经出箱,
// drain 按 PG 当时的状态决定写入还是删除, 所以扫描顺序不承重
export const detectSearchDrift = async (): Promise<SearchDrift> => {
  const client = getMeiliClient()
  if (!client) {
    throw new Error('未配置 MEILISEARCH_HOST / MEILISEARCH_ADMIN_API_KEY')
  }
  const index = client.index(GALGAME_INDEX)

  const indexHashById = new Map<number, string | undefined>()
  for (let offset = 0; ; offset += RECONCILE_BATCH_SIZE) {
    const page = await index.getDocuments<{ id: number; docHash?: string }>({
      fields: ['id', 'docHash'],
      limit: RECONCILE_BATCH_SIZE,
      offset
    })
    for (const doc of page.results) {
      indexHashById.set(doc.id, doc.docHash)
    }
    if (
      page.results.length === 0 ||
      offset + page.results.length >= page.total
    ) {
      break
    }
  }

  const missing: number[] = []
  const stale: number[] = []
  const seen = new Set<number>()
  let lastId = 0
  for (;;) {
    const rows = await prisma.patch.findMany({
      where: { id: { gt: lastId } },
      orderBy: { id: 'asc' },
      take: RECONCILE_BATCH_SIZE,
      select: PATCH_SEARCH_SELECT
    })
    if (rows.length === 0) {
      break
    }
    for (let i = 0; i < rows.length; i += DOC_BUILD_CHUNK_SIZE) {
      for (const row of rows.slice(i, i + DOC_BUILD_CHUNK_SIZE)) {
        seen.add(row.id)
        if (!indexHashById.has(row.id)) {
          missing.push(row.id)
          continue
        }
        // 构建抛错 (例如简介嵌套过深撑爆调用栈) 只算这一份过时：入箱后由 drain 计次、隔离，
        // 不让一份文档中止整次检测
        const docHash = await patchToSearchDoc(row).then(
          (doc) => doc.docHash,
          (error: unknown) => {
            // eslint-disable-next-line no-console
            console.error(
              `[kun-search] 对账构建 patch ${row.id} 的文档失败, 按过时入箱:`,
              error instanceof Error ? error.message : error
            )
            return null
          }
        )
        if (docHash === null || indexHashById.get(row.id) !== docHash) {
          stale.push(row.id)
        }
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
    lastId = rows[rows.length - 1].id
  }

  const extra = [...indexHashById.keys()].filter((id) => !seen.has(id))
  return { total: seen.size, missing, extra, stale }
}

export interface SearchReconcileResult {
  total: number
  missing: number
  extra: number
  stale: number
}

// 对账 = 检测 + 入箱 (对账模式: 只换发 seq, 不复位已退避 / 隔离行的失败记录), 写入由 drain
// 完成。多出来的文档同样只入箱: drain 读不到这个 patch 就删除它的文档
export const reconcileSearchIndex =
  async (): Promise<SearchReconcileResult> => {
    const drift = await detectSearchDrift()
    await enqueueSearchOutboxBatch(
      prisma,
      [...drift.missing, ...drift.extra, ...drift.stale],
      { mode: 'reconcile' }
    )
    return {
      total: drift.total,
      missing: drift.missing.length,
      extra: drift.extra.length,
      stale: drift.stale.length
    }
  }
