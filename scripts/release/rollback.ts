// pnpm deploy:rollback [发布 id]: 把线上切回一个旧发布 (不给 id 时是在线发布之前最新的那一个)。闸门与
// 部署相同, 不过就切回原来的发布; 不清理旧发布。
//
// 不读 .env、不连库: 回滚只换代码, .env 坏了也要能回滚。注意它不知道库走到了哪一步: 部署的 post 迁移
// (删列、加约束) 在新发布上线之后才执行, 回滚到那之前构建的发布时, 旧代码可能还在用已经删掉的东西
import { setTimeout as delay } from 'timers/promises'
import { kunFetchHealth, rollbackTo } from './activate'
import { isReleaseId, kunRepoReleaseLayout } from './layout'
import { assertShellNodeVersion, kunDeclaredNodeVersion } from './node'
import { createKunPm2, kunEcosystemApps } from './pm2'

const main = async () => {
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  const [target] = args
  if (args.length > 1 || (target !== undefined && !isReleaseId(target))) {
    console.error(
      '用法: pnpm deploy:rollback [发布 id], id 形如 20261126030405-fc8b626, pnpm deploy:list 列出现有的发布'
    )
    return 1
  }
  const repoDir = process.cwd()
  const expectedNode = kunDeclaredNodeVersion(repoDir)
  // 闸门发现进程的 Node 不对时会 pm2 update, 它换成的是当前 shell 的 node
  assertShellNodeVersion(expectedNode)
  const apps = kunEcosystemApps(repoDir)
  const result = await rollbackTo(
    {
      layout: kunRepoReleaseLayout(repoDir),
      pm2: createKunPm2({ repoDir, apps }),
      apps,
      expectedNode,
      fetchHealth: kunFetchHealth,
      sleep: (ms) => delay(ms),
      log: (message) => console.log(message)
    },
    target
  )
  if (!result.ok) {
    console.error(`\n✗ ${result.id} 没有通过闸门: ${result.reason}`)
    console.error(
      result.rollbackFailed === undefined
        ? `  已切回原来在线的 ${result.rolledBackTo}`
        : `  切回原来在线的 ${result.rolledBackTo} 也出了问题: ${result.rollbackFailed}。线上可能没有在服务: 立刻用 pm2 ls 与 pnpm deploy:list 查看`
    )
    return 1
  }
  console.log(`\n✓ 已回滚到 ${result.id} (原来在线的是 ${result.previous})`)
  console.log(
    '  只回退了代码: 这之后执行过的 post 迁移没有撤销。其中有删列、加约束的, 旧代码可能出错, 看一眼 db/migrations 里这期间的 post 迁移'
  )
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(
      `\n✗ 没有回滚: ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
)
