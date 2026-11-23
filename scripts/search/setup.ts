/* eslint-disable no-console */
import { execSync } from 'child_process'

const runCommand = (command: string) => {
  console.log(`\n$ ${command}`)
  execSync(command, { stdio: 'inherit' })
}

// 首次全流程：拉起引擎 → 建索引并下发 settings → 对账 (空索引上就是全量同步，排空后返回)
try {
  runCommand('pnpm search:engine')
  runCommand('pnpm search:ensure --apply')
  runCommand('pnpm search:reconcile')
  console.log(
    '\n搜索引擎与索引已就绪，可打开 KUN_MEILISEARCH_ENABLED 灰度查询路径'
  )
} catch (error) {
  console.error(error)
  process.exit(1)
}
