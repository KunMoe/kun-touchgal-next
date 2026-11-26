import 'dotenv/config'
import { parseArgs } from 'util'
import { kunSelectMissingTablesAndColumns } from './lib/drift'
import { kunPlanMigrations } from './lib/migrationFiles'
import {
  kunCheckObjectDrift,
  kunCheckPrismaDrift,
  kunConnect,
  kunCountDerivedMismatches,
  kunExportObjects,
  kunFindInvalidIndexes,
  kunFindPendingIndexLeftovers,
  kunLoadMigrationFiles,
  kunReadLedger,
  kunRunCli
} from './lib/runtime'

// 只读校验: 拿库的实际状态对照代码期望的状态, 任何一项不符即以非零码退出。
//   pnpm db:verify               迁移全部执行、无 INVALID 索引、库级对象与快照一致
//   pnpm db:verify --phase pre   只要求 pre 迁移执行完, 不比对快照 (post 可能还没跑)
//   pnpm db:verify --prisma      另查表、列与普通索引是否与 prisma/schema 一致
//   pnpm db:verify --phase pre --expand
//       还有 post 迁移待执行时用: 表结构此刻对不上是正常的 (post 负责的删列、加约束还没做),
//       只确认 schema 里的表与列库里都已经有了
//   pnpm db:verify --counts      另对 6 个派生列做全量对账 (全表聚合, 低峰执行)

kunRunCli(async () => {
  const { values } = parseArgs({
    options: {
      phase: { type: 'string', default: 'all' },
      prisma: { type: 'boolean', default: false },
      expand: { type: 'boolean', default: false },
      counts: { type: 'boolean', default: false }
    }
  })
  if (values.phase !== 'pre' && values.phase !== 'all') {
    throw new Error('--phase 只能是 pre 或 all')
  }
  if (values.expand && (values.prisma || values.phase !== 'pre')) {
    throw new Error('--expand 只与 --phase pre 连用, 且不与 --prisma 同时给')
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
    const ledger = await kunReadLedger(client)
    const plan = kunPlanMigrations(files, ledger, values.phase)
    report(
      `迁移台账 (--phase ${values.phase})`,
      plan.ok
        ? plan.pending.map((file) => `待执行 ${file.fileName}`)
        : [`${plan.reason}: ${plan.detail}`]
    )

    const applied = new Set(
      ledger.filter((row) => row.kind === 'sql').map((row) => row.version)
    )
    const leftovers = await kunFindPendingIndexLeftovers(
      client,
      files.filter((file) => !applied.has(file.version))
    )
    report(
      'INVALID 索引',
      (await kunFindInvalidIndexes(client))
        .filter((name) => !leftovers.includes(name))
        .map((name) => `INVALID ${name}`)
    )
    for (const name of leftovers) {
      console.log(
        `    ${name} 是被打断的迁移留下的, 下次执行 db:migrate 时会先删掉重建`
      )
    }

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
      if (drift.unexpected.length > 0) {
        console.log(
          '    以上是让库对齐 schema 所需的语句, 只用来说明差异, 不要照抄到生产执行'
        )
      }
    }

    if (values.expand) {
      const missing = kunSelectMissingTablesAndColumns(
        kunCheckPrismaDrift().unexpected
      )
      report(
        'schema 里的表与列库里都已存在',
        missing.map((statement) => `库里还没有: ${statement}`)
      )
      if (missing.length > 0) {
        console.log(
          '    新表与新列要由 pre 迁移建好: 漏写了迁移就补一个, 写在 post 里的挪到 pre'
        )
      }
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
