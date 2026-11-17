/* eslint-disable no-console */
import 'dotenv/config'
import { parseArgs } from 'util'
import { kunPlanMigrations } from './lib/migrationFiles'
import {
  kunConnect,
  kunInsertLedgerRow,
  kunLoadMigrationFiles,
  kunPrepareLedger,
  kunReadLedger,
  kunRunCli,
  kunRunMigrations
} from './lib/runtime'
import type { Client } from 'pg'
import type { KunMigrationFile, KunMigrationPhase } from './lib/migrationFiles'

// 按版本号顺序执行 db/migrations 下尚未执行的迁移, 每个文件在每个环境恰好执行一次。
//   pnpm db:migrate                      全部待执行 (新环境 / 本地)
//   pnpm db:migrate --phase pre          只跑 pre: 与线上旧代码兼容的扩张, 构建之前执行
//   pnpm db:migrate --phase post         只跑 post: 需要新代码先上线的收缩与回填
//   pnpm db:migrate --status             列出每个文件的执行状态 (只读)
//   pnpm db:migrate --dry-run            列出将要执行的文件 (只读)
//   pnpm db:migrate --mark-applied 0001 --reason inspect-2026-11-18
//       把库里已经存在的状态登记进台账而不执行; 先用 pnpm db:inspect 确认对象与快照一致

const PHASES = ['pre', 'post', 'all']

const printStatus = async (client: Client, files: KunMigrationFile[]) => {
  const ledger = await kunReadLedger(client)
  const byVersion = new Map(ledger.map((row) => [row.version, row]))

  for (const file of files) {
    const row = byVersion.get(file.version)
    const state = !row
      ? '待执行'
      : row.baseline
        ? `已登记 ${row.applied_at.toISOString()} (${row.note})`
        : `已执行 ${row.applied_at.toISOString()} ${row.execution_ms}ms`
    console.log(`${file.fileName.padEnd(44)} ${file.phase.padEnd(5)} ${state}`)
  }
  for (const row of ledger.filter((row) => row.kind !== 'sql')) {
    console.log(`${row.version.padEnd(44)} ${row.kind.padEnd(5)} 已执行`)
  }

  const plan = kunPlanMigrations(files, ledger, 'all')
  if (!plan.ok) {
    throw new Error(`${plan.reason}: ${plan.detail}`)
  }
}

const markApplied = async (
  client: Client,
  files: KunMigrationFile[],
  versions: string[],
  reason: string | undefined
) => {
  if (!reason) {
    throw new Error(
      '--mark-applied 必须带 --reason 写明登记依据, 例如 inspect-2026-11-18'
    )
  }
  await kunPrepareLedger(client)
  const applied = new Set((await kunReadLedger(client)).map((r) => r.version))
  const targets = versions.map((version) => {
    const file = files.find((candidate) => candidate.version === version)
    if (!file) {
      throw new Error(`db/migrations 下没有版本 ${version}`)
    }
    if (applied.has(version)) {
      throw new Error(`版本 ${version} 已在台账里`)
    }
    return file
  })

  await client.query('BEGIN')
  try {
    for (const file of targets) {
      await kunInsertLedgerRow(client, file, 0, reason)
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
  for (const file of targets) {
    console.log(`已登记 ${file.fileName} (未执行)`)
  }
}

kunRunCli(async () => {
  const { values } = parseArgs({
    options: {
      phase: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      'mark-applied': { type: 'string', multiple: true },
      reason: { type: 'string' }
    }
  })
  // 互斥的参数一律报错: --mark-applied 连着 --dry-run 时若照常登记, 就成了真写
  const marking = values['mark-applied'] !== undefined
  const readOnly = values.status || values['dry-run']
  if (values.status && values['dry-run']) {
    throw new Error('--status 与 --dry-run 只能选一个')
  }
  if (marking && (readOnly || values.phase !== undefined)) {
    throw new Error('--mark-applied 不能与 --status / --dry-run / --phase 连用')
  }
  if (values.status && values.phase !== undefined) {
    throw new Error('--status 列出全部迁移, 不接受 --phase')
  }
  if (values.reason !== undefined && !marking) {
    throw new Error('--reason 只与 --mark-applied 连用')
  }
  const phase = (values.phase ?? 'all') as KunMigrationPhase | 'all'
  if (!PHASES.includes(phase)) {
    throw new Error(`--phase 只能是 ${PHASES.join(' / ')}`)
  }

  const files = kunLoadMigrationFiles()
  const client = await kunConnect(
    process.env.KUN_DATABASE_URL,
    'KUN_DATABASE_URL',
    { readOnly }
  )
  try {
    if (values.status) {
      await printStatus(client, files)
    } else if (values['mark-applied']) {
      await markApplied(client, files, values['mark-applied'], values.reason)
    } else if (values['dry-run']) {
      const plan = kunPlanMigrations(files, await kunReadLedger(client), phase)
      if (!plan.ok) {
        throw new Error(`${plan.reason}: ${plan.detail}`)
      }
      for (const file of plan.pending) {
        console.log(`将执行 ${file.fileName} (${file.phase}, ${file.mode})`)
      }
      console.log(`共 ${plan.pending.length} 个 (--phase ${phase})`)
    } else {
      const count = await kunRunMigrations(client, files, phase)
      console.log(`✓ 执行了 ${count} 个迁移 (--phase ${phase})`)
    }
  } finally {
    await client.end()
  }
})
