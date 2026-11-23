/* eslint-disable no-console */

// deploy:build 的步骤编排。真正执行命令、切换构建目录的是 deployBuild.ts, 这里只定顺序和
// 每一步失败时怎么办, 所以能用假的 run / capture / build / activate 测试。
//
// 库的结构只由 db/migrations 推进, 部署链不执行 prisma db push。漏写迁移、库被手工改过,
// 不会再被悄悄抹平: 没有待执行的 post 迁移时由构建之前的全量校验挡下; 有的时候构建之前
// 只挡得住缺表缺列, 其余差异要到 post 之后的收尾校验才报出来 (那时新构建已上线)
//
// 搜索索引的定义也随部署下发 (server/search/indexAdmin.ts): 扩张 (新的可排序 / 可过滤字段)
// 在切换之前, 收缩在切换之后; 切换之后再对账一次, 文档形状变了就由 cron 的 drain 重写, 已隔离
// 的行也在这时复位重试一次 (被拒的原因多半要靠一次部署修好)。线上 settings 以代码为准: 在线上
// 手工改过的声明键会被下一次部署覆盖。搜索是可选特性, 这几步失败只告警、不中止部署, 也不改变
// 退出码; 未配置 Meilisearch 时命令自己跳过

export interface KunDeployChainDeps {
  // 执行一条命令, 失败时抛错
  run: (command: string) => void
  // 执行一条命令并返回它的标准输出, 失败时抛错
  capture: (command: string) => string
  build: () => void
  activate: () => void
}

// 走到切换之后才会有的三种结局。之前任何一步失败都直接抛错: 尚未切换, 线上不受影响
export type KunDeployChainOutcome =
  | 'ok'
  // 新构建已上线, 但 post 迁移没有执行完
  | 'post-migration-failed'
  // 新构建已上线, post 迁移也执行完了, 但库的最终状态与迁移 / 快照 / schema 对不上
  | 'verify-failed'

interface KunSearchDeployStep {
  command: string
  // 这一步没做成时线上会怎样, 写进告警
  consequence: string
}

export const KUN_SEARCH_PRE_ACTIVATE_STEPS: KunSearchDeployStep[] = [
  {
    command: 'pnpm search:ensure --apply --phase pre',
    consequence:
      '新代码要用的可排序 / 可过滤 / 检索字段还没下发, 依赖它们的查询会降级到 basic 引擎'
  }
]
export const KUN_SEARCH_POST_ACTIVATE_STEPS: KunSearchDeployStep[] = [
  {
    command: 'pnpm search:ensure --apply --phase post',
    consequence: '新代码不再用的字段还留在线上, 不影响查询'
  },
  {
    command: 'pnpm search:reconcile --enqueue-only --retry-failed',
    consequence:
      '这次部署改变的文档内容要等 05:00 的对账才会重写, 已隔离的行继续隔离'
  }
]

const runSearchSteps = (
  run: (command: string) => void,
  steps: KunSearchDeployStep[]
) => {
  for (const { command, consequence } of steps) {
    try {
      run(command)
    } catch {
      console.warn(
        `\n⚠ 搜索索引的部署步骤失败, 部署照常继续: ${command}。按上方报错处理后单独重跑这一条; 没处理之前${consequence}`
      )
    }
  }
}

// db:migrate --dry-run 的最后一行是「共 N 个 (--phase x)」
const PLANNED_SUMMARY_PATTERN = /^共 (\d+) 个/m

export const kunCountPlannedMigrations = (dryRunOutput: string) => {
  const matched = PLANNED_SUMMARY_PATTERN.exec(dryRunOutput)
  if (!matched) {
    throw new Error(
      `认不出 db:migrate --dry-run 的输出, 无法判断有没有待执行的 post 迁移: ${dryRunOutput}`
    )
  }
  return Number(matched[1])
}

export const kunRunDeployChain = ({
  run,
  capture,
  build,
  activate
}: KunDeployChainDeps): KunDeployChainOutcome => {
  run('git pull')

  // pre 迁移与线上旧代码兼容, 所以排在构建之前
  try {
    run('pnpm db:migrate --phase pre')
  } catch (error) {
    console.error('\n✗ pre 迁移失败: 部署在构建之前中止, 线上的构建没有变化')
    throw error
  }

  // 没有待执行的 post 迁移时, 库此刻就该是最终形态, 全量校验 (含表结构与库级对象)。
  // 有的话 post 要等新代码上线才执行, 它负责的删列、加约束、触发器此刻可以与期望对不上,
  // 全量比对会把带收缩的部署一律挡下。这时只确认新代码一启动就要用的表与列都已建好
  // (它们必须出自 pre 迁移), 其余留到 post 之后再比
  const hasPendingPost =
    kunCountPlannedMigrations(
      capture('pnpm -s db:migrate --phase post --dry-run')
    ) > 0
  try {
    run(
      hasPendingPost
        ? 'pnpm db:verify --phase pre --expand'
        : 'pnpm db:verify --prisma'
    )
  } catch (error) {
    console.error(
      '\n✗ 构建之前的数据库校验未通过: 部署中止, 线上的构建没有变化。按上方 db:verify 列出的项目处理后重新部署'
    )
    throw error
  }

  // deploy:build 不跑 install, schema 变了要靠这一步重新生成 client
  run('pnpm prisma:generate')
  build()
  // 扩张只加不减, 线上的旧代码照常可用
  runSearchSteps(run, KUN_SEARCH_PRE_ACTIVATE_STEPS)
  try {
    activate()
  } catch (error) {
    console.error(
      '\n✗ 切换构建失败: post 迁移尚未执行。确认线上运行的是哪个版本; 若新构建已在运行, 单独补跑 pnpm db:migrate --phase post && pnpm db:verify --prisma'
    )
    throw error
  }

  // post 迁移需要新代码先上线。此时新构建已在运行, 失败也不回滚构建, 留给人处理后单独重跑
  const outcome = ((): KunDeployChainOutcome => {
    try {
      run('pnpm db:migrate --phase post')
    } catch {
      return 'post-migration-failed'
    }
    try {
      run('pnpm db:verify --prisma')
    } catch {
      return 'verify-failed'
    }
    return 'ok'
  })()

  // 排在 post 迁移之后: post 迁移执行成功时, 它改了的文档内容这一次对账就能发现 (失败时
  // 补跑之后要再对账一次, 见 kunReportDeployChain)。与数据库的结局无关, 照常执行
  runSearchSteps(run, KUN_SEARCH_POST_ACTIVATE_STEPS)
  return outcome
}

// 打印部署链的结局, 返回进程退出码。切换之前失败是抛错 (退出码 1, 线上的构建没变);
// 这里的 2 专指「新构建已上线, 但数据库这边没有收尾」, 两者要能从退出码上分开
export const kunReportDeployChain = (outcome: KunDeployChainOutcome) => {
  if (outcome === 'post-migration-failed') {
    console.error('\n✗ post 迁移失败: 新构建已上线并在运行, 没有回滚')
    console.error(
      '  按上方的报错处理后单独重跑: pnpm db:migrate --phase post && pnpm db:verify --prisma'
    )
    console.error(
      '  配了 Meilisearch 的话再跑 pnpm search:reconcile --enqueue-only: 否则 post 迁移改到的文档要等 05:00 的对账才会重写'
    )
    return 2
  }
  if (outcome === 'verify-failed') {
    console.error(
      '\n✗ 收尾的数据库校验没有通过或没能跑完: 新构建已上线并在运行, post 迁移也已执行'
    )
    console.error(
      '  按上方 db:verify 列出的项目处理, 再跑一遍 pnpm db:verify --prisma 确认; 不处理的话下一次部署多半会在构建之前被挡住'
    )
    return 2
  }
  return 0
}
