import { prisma } from '~/prisma/index'
import { COMMENT_HTML_VERSION } from '~/app/api/utils/render/markdownToHtmlComment'
import {
  persistCommentHtml,
  resolveCommentHtml,
  type StaleCommentHtml
} from '~/app/api/patch/comment/html'

const BATCH_SIZE = 200

const backfillCommentHtml = async () => {
  let processed = 0
  // 没写成: CAS 未命中 (读出之后正文被编辑, 或已被评论分页的读时自愈写回),
  // 或这一条写库失败 (错误已单独打出)
  let skipped = 0
  // 渲染缺陷 (render-error): 结果不落库, 这些行留在旧版本
  let failed = 0
  let cursorId = 0

  while (true) {
    const batch = await prisma.patch_comment.findMany({
      where: {
        content_html_version: { not: COMMENT_HTML_VERSION },
        id: { gt: cursorId }
      },
      select: {
        id: true,
        content: true,
        content_html: true,
        content_html_version: true,
        updated: true
      },
      take: BATCH_SIZE,
      orderBy: { id: 'asc' }
    })

    if (batch.length === 0) {
      break
    }

    const heals: StaleCommentHtml[] = []
    for (const row of batch) {
      // 不走渲染缓存: 脚本一旦连上 redis 进程就退不出来, 回填也不该去预热缓存
      const { heal } = await resolveCommentHtml(row, { cache: false })
      if (heal === null) {
        failed++
        console.error(`[backfill] comment ${row.id} failed to render`)
      } else {
        heals.push(heal)
      }
    }

    const result = await persistCommentHtml(heals)
    processed += result.written
    skipped += result.skipped
    cursorId = batch[batch.length - 1].id

    console.log(
      `[backfill] cursor=${cursorId}, processed=${processed}, skipped=${skipped}, failed=${failed}`
    )
  }

  console.log(
    `[backfill] complete. total processed=${processed}, skipped=${skipped}, failed=${failed}`
  )
}

backfillCommentHtml()
  .catch((error) => {
    console.error('[backfill] fatal:', error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
