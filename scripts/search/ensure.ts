import 'dotenv/config'
import { parseArgs } from 'util'
import {
  ensureSearchIndex,
  type SettingsDiff
} from '~/server/search/indexAdmin'
import { GALGAME_INDEX } from '~/server/search/settings'

// 核对或下发搜索索引的定义 (主键与 settings), 取代 search:init。
//   pnpm search:ensure                       只读核对 (同 --check): 索引存在且没有差异才退出 0
//   pnpm search:ensure --apply               建索引并下发全部差异 (新环境)
//   pnpm search:ensure --apply --phase pre   切换到新构建之前: 下发扩张与变更
//   pnpm search:ensure --apply --phase post  新构建上线之后: 下发收缩

const parseOptions = (): Parameters<typeof ensureSearchIndex>[0] => {
  const { values } = parseArgs({
    options: {
      check: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
      phase: { type: 'string' }
    }
  })
  if (values.check && values.apply) {
    throw new Error('--check 与 --apply 只能选一个')
  }
  const { phase } = values
  if (phase === undefined) {
    return { mode: values.apply ? 'apply' : 'check' }
  }
  if (!values.apply) {
    throw new Error('--phase 只与 --apply 连用')
  }
  if (phase === 'pre' || phase === 'post') {
    return { mode: 'apply', phase }
  }
  throw new Error('--phase 只能是 pre / post')
}

const printDiffs = (diffs: SettingsDiff[]) => {
  console.log(`差异 ${diffs.length} 项`)
  for (const diff of diffs) {
    console.log(`  ${diff.key} (${diff.kind})`)
    console.log(`    代码: ${JSON.stringify(diff.expected)}`)
    console.log(`    线上: ${JSON.stringify(diff.actual)}`)
  }
}

const main = async () => {
  const options = parseOptions()
  const report = await ensureSearchIndex(options)
  if (!report) {
    console.log('未配置 MEILISEARCH_HOST / MEILISEARCH_ADMIN_API_KEY, 跳过')
    return 0
  }

  console.log(
    `patch 条数 ${report.patchCount} / maxTotalHits ${report.maxTotalHits}`
  )
  // 条数达到上限时搜索总数与深分页已被截断: 两种模式都非零退出, 部署链因此打出 ⚠
  const overLimit = report.patchCount >= report.maxTotalHits
  if (report.missing) {
    console.log(`索引 ${GALGAME_INDEX} 不存在, 运行 --apply 创建`)
    return 1
  }
  if (report.created) {
    console.log(`已创建索引 ${GALGAME_INDEX} (主键 id)`)
  }
  printDiffs(report.diffs)
  if (options.mode === 'check') {
    return report.diffs.length === 0 && !overLimit ? 0 : 1
  }

  const keys = (diffs: SettingsDiff[]) =>
    diffs.map((diff) => diff.key).join(', ') || '无'
  console.log(`已下发: ${keys(report.applied)}`)
  const deferred = report.diffs.filter((diff) => !report.applied.includes(diff))
  if (deferred.length > 0) {
    console.log(`留给另一阶段: ${keys(deferred)}`)
  }
  return overLimit ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
