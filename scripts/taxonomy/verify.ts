import 'dotenv/config'
import { parseArgs } from 'util'
import { kunConnect, kunRunCli } from '~/scripts/db/lib/runtime'
import {
  formatBlockingIds,
  formatTaxonomyReport,
  isTaxonomyVerified,
  verifyResourceTaxonomy
} from './lib/verify'

// 只读核查: 拿全表数据对照资源词表, 回答「一次词表变更做完没有」。
//   pnpm taxonomy:verify          按类给行数与取值分布, 并逐行列出这一类的全部行 (id、深链、带着的值)
//   pnpm taxonomy:verify --ids    另外给去重后的拦收尾的资源 id 与作品 id, 逗号分隔
// 以 0 退出 = 没有任何一行带着词表外的值: 这是宣布迁移完成、删除过渡代码的唯一判据
// (流程见 AGENTS.md「资源词表变更」)。非 0 = 还有残留, 或者没查成, 输出里写明是哪一种。
// 连接是只读会话, 写语句在库端就被拒绝, 可以直接对生产库跑

kunRunCli(async () => {
  const { values } = parseArgs({
    options: { ids: { type: 'boolean', default: false } }
  })

  const client = await kunConnect(
    process.env.KUN_DATABASE_URL,
    'KUN_DATABASE_URL',
    { readOnly: true }
  )
  let report
  try {
    report = await verifyResourceTaxonomy(client)
  } finally {
    await client.end()
  }

  const siteUrl = (process.env.KUN_VISUAL_NOVEL_SITE_URL ?? '').replace(
    /\/+$/,
    ''
  )
  console.log(formatTaxonomyReport(report, siteUrl).join('\n'))
  if (values.ids) {
    console.log(`\n${formatBlockingIds(report).join('\n')}`)
  }
  if (!isTaxonomyVerified(report)) {
    throw new Error(
      `词表核查未通过: 资源 ${report.resources.blockingRows} 行、作品 ${report.patches.blockingRows} 行带着词表外的值`
    )
  }
  console.log('\n✓ 词表核查通过: 没有词表外的值')
})
