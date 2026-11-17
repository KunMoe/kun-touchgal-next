/* eslint-disable no-console */

// deploy:build 的步骤编排。真正执行命令、切换构建目录的是 deployBuild.ts, 这里只定顺序和
// 每一步失败时怎么办, 所以能用假的 run / capture / build / activate 测试。
//
// 双轨期: 迁移已经接进部署链, prisma:push 仍留作安全网, db:verify 失败只告警不阻断。
// 等至少两次部署证实 push 之前表结构已与 schema 一致, 再删掉 push 并把校验改成阻断

export interface KunDeployChainDeps {
  // 执行一条命令, 失败时抛错
  run: (command: string) => void
  // 执行一条命令并返回它的标准输出, 失败时抛错
  capture: (command: string) => string
  build: () => void
  activate: () => void
}

export interface KunDeployChainResult {
  // 只告警、不阻断的失败
  warnings: string[]
  // 新构建已上线, 但 post 迁移没有执行完
  postMigrationFailed: boolean
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
}: KunDeployChainDeps): KunDeployChainResult => {
  const warnings: string[] = []
  const verify = (stage: string, command: string) => {
    try {
      run(command)
    } catch {
      warnings.push(`${stage}未通过: ${command}`)
    }
  }

  run('git pull')

  // pre 迁移与线上旧代码兼容, 所以排在构建之前
  try {
    run('pnpm db:migrate --phase pre')
  } catch (error) {
    console.error(
      '\n✗ pre 迁移失败: 部署在构建之前中止, 线上仍在运行上一个版本'
    )
    throw error
  }

  // push 把表结构直接推到 schema。有待执行的 post 迁移时它不能排在前面: 那等于在旧构建
  // 还在线时抢先做掉 post 里的收缩 (删列、加 NOT NULL / UNIQUE), 或者因为数据丢失告警
  // 而让部署停在这里。这种情况下 push 推迟到 post 之后
  const pushAfterPost =
    kunCountPlannedMigrations(
      capture('pnpm -s db:migrate --phase post --dry-run')
    ) > 0

  if (pushAfterPost) {
    verify('构建之前的校验', 'pnpm db:verify --phase pre')
  } else {
    // 这里通过就说明迁移已经把表结构带到了 schema, push 只剩白名单里的噪音可做
    verify('push 之前的校验', 'pnpm db:verify --phase pre --prisma')
    run('pnpm prisma:push')
  }

  build()
  try {
    activate()
  } catch (error) {
    console.error(
      '\n✗ 切换构建失败: post 迁移尚未执行。确认线上运行的是哪个版本; 若新构建已在运行, 单独补跑 pnpm db:migrate --phase post && pnpm db:verify'
    )
    throw error
  }

  // post 迁移需要新代码先上线。此时新构建已在运行, 失败也不回滚构建, 留给人处理后单独重跑。
  // 失败后不再 push: 迁移没做完的那部分 (多半带着数据处理) 不能交给 push 去硬推
  try {
    run('pnpm db:migrate --phase post')
  } catch {
    return { warnings, postMigrationFailed: true }
  }

  if (pushAfterPost) {
    verify('push 之前的校验', 'pnpm db:verify --prisma')
    try {
      run('pnpm prisma:push')
    } catch {
      warnings.push(
        '安全网 pnpm prisma:push 失败: 新构建已上线, 表结构与 schema 的差异见上方输出'
      )
    }
  } else {
    verify('收尾校验', 'pnpm db:verify')
  }

  return { warnings, postMigrationFailed: false }
}

// 打印部署链的结果, 返回进程退出码
export const kunReportDeployChain = ({
  warnings,
  postMigrationFailed
}: KunDeployChainResult) => {
  if (warnings.length > 0) {
    console.warn(
      `\n⚠ 数据库步骤有 ${warnings.length} 项未通过 (过渡期只告警, 不阻断部署):`
    )
    for (const warning of warnings) {
      console.warn(`  ${warning}`)
    }
    console.warn('  明细见上方对应命令的输出')
  }
  if (postMigrationFailed) {
    console.error('\n✗ post 迁移失败: 新构建已上线并在运行, 没有回滚')
    console.error(
      '  按上方的报错处理后单独重跑: pnpm db:migrate --phase post && pnpm db:verify --prisma'
    )
    return 1
  }
  return 0
}
