/* eslint-disable no-console */
import 'dotenv/config'
import { parseArgs } from 'util'
import { kunPlanMigrations } from './lib/migrationFiles'
import {
  kunCheckObjectDrift,
  kunCheckPrismaDrift,
  kunConnect,
  kunCountDerivedMismatches,
  kunExportObjects,
  kunFindInvalidIndexes,
  kunLoadMigrationFiles,
  kunReadLedger,
  kunRunCli
} from './lib/runtime'

// 只读校验: 拿库的实际状态对照代码期望的状态, 任何一项不符即以非零码退出。
//   pnpm db:verify               迁移全部执行、无 INVALID 索引、库级对象与快照一致
//   pnpm db:verify --phase pre   只要求 pre 迁移执行完, 不比对快照 (post 可能还没跑)
//   pnpm db:verify --prisma      另查表、列与普通索引是否与 prisma/schema 一致
//   pnpm db:verify --counts      另对 6 个派生列做全量对账 (全表聚合, 低峰执行)

kunRunCli(async () => {
  const { values } = parseArgs({
    options: {
      phase: { type: 'string', default: 'all' },
      prisma: { type: 'boolean', default: false },
      counts: { type: 'boolean', default: false }
    }
  })
  if (values.phase !== 'pre' && values.phase !== 'all') {
    throw new Error('--phase 只能是 pre 或 all')
  }

  let failed = 0
  const report = (label: string, problems: string[]) => {
    console.log(`${problems.length === 0 ? '✓' : '✗'} ${label}`)
    for (const problem of problems) {
      console.log(`    ${problem}`)
    }
    failed += problems.length === 0 ? 0 : 1
  }

  const files = kunLoadMigrationFiles()
  const client = await kunConnect(
    process.env.KUN_DATABASE_URL,
    'KUN_DATABASE_URL',
    { readOnly: true }
  )
  try {
    const plan = kunPlanMigrations(
      files,
      await kunReadLedger(client),
      values.phase
    )
    report(
      `迁移台账 (--phase ${values.phase})`,
      plan.ok
        ? plan.pending.map((file) => `待执行 ${file.fileName}`)
        : [`${plan.reason}: ${plan.detail}`]
    )

    report(
      'INVALID 索引',
      (await kunFindInvalidIndexes(client)).map((name) => `INVALID ${name}`)
    )

    if (values.phase === 'all') {
      report(
        '库级对象与 db/objects.snapshot.sql 一致',
        kunCheckObjectDrift(await kunExportObjects(client))
      )
    }

    if (values.prisma) {
      const drift = kunCheckPrismaDrift()
      report('表结构与 prisma/schema 一致 (已扣除白名单噪音)', [
        ...drift.unexpected.map((statement) => `白名单之外: ${statement}`),
        ...drift.stale.map((statement) => `白名单条目未再出现: ${statement}`)
      ])
    }

    if (values.counts) {
      report(
        '派生列对账',
        (await kunCountDerivedMismatches(client))
          .filter((result) => result.mismatched !== 0)
          .map((result) =>
            result.mismatched === null
              ? `${result.column} 查询失败: ${result.error}`
              : `${result.column} 有 ${result.mismatched} 行不一致`
          )
      )
    }
  } finally {
    await client.end()
  }

  if (failed > 0) {
    throw new Error(`校验未通过: ${failed} 项`)
  }
  console.log('✓ 校验通过')
})
