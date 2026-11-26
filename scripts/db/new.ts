import 'dotenv/config'
import { writeFileSync } from 'fs'
import path from 'path'
import { parseArgs } from 'util'
import {
  KUN_MIGRATIONS_DIR,
  kunCheckPrismaDrift,
  kunConnectScratch,
  kunLoadMigrationFiles,
  kunReplayIntoScratch,
  kunRunCli
} from './lib/runtime'

// 新建一个迁移文件草稿。改 prisma/schema 之后:
//   pnpm db:new add_patch_foo            草稿 = 「已有迁移的回放结果 → 当前 schema」的差异
//   pnpm db:new drop_patch_bar --phase post   需要新代码先上线的收缩 / 回填
//   pnpm db:new patch_foo_idx --notx     并发建索引 (文件里只能放 CONCURRENTLY 语句)
// 草稿必须基于回放库而不是开发库: 开发库若先跑过 prisma:push, 对它做差异结果是空的。
// 生成后按需手改 (大表上的索引拆到 .notx 文件、补 USING、补回填), 再跑 pnpm db:snapshot

kunRunCli(async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      phase: { type: 'string', default: 'pre' },
      notx: { type: 'boolean', default: false }
    }
  })
  const [slug] = positionals
  if (positionals.length !== 1 || !/^[a-z0-9_]+$/.test(slug)) {
    throw new Error(
      '用法: pnpm db:new <slug> [--phase post] [--notx], slug 只含小写字母、数字、下划线'
    )
  }
  if (values.phase !== 'pre' && values.phase !== 'post') {
    throw new Error('--phase 只能是 pre 或 post')
  }

  const files = kunLoadMigrationFiles()
  const version = String(Number(files.at(-1)?.version ?? 0) + 1).padStart(
    4,
    '0'
  )
  const fileName = `${version}_${slug}${values.notx ? '.notx' : ''}.sql`

  const client = await kunConnectScratch()
  let drift: ReturnType<typeof kunCheckPrismaDrift>
  try {
    await kunReplayIntoScratch(client, files)
    drift = kunCheckPrismaDrift(process.env.KUN_DB_SCRATCH_URL)
  } finally {
    await client.end()
  }
  // Prisma 把「数据将丢失」之类的警告写在脚本开头的块注释里, 原样带进草稿
  const warnings = /^\s*\/\*[\s\S]*?\*\//.exec(drift.raw)?.[0].trim()

  const content = [
    `-- phase: ${values.phase}`,
    '-- (这里写清这个迁移做什么、为什么; post 迁移另写明回滚影响)',
    '',
    ...(warnings ? [warnings, ''] : []),
    ...(drift.unexpected.length > 0
      ? drift.unexpected.map((statement) => `${statement};\n`)
      : ['-- prisma/schema 与已有迁移没有结构差异, 在这里手写 SQL', ''])
  ].join('\n')

  writeFileSync(path.join(KUN_MIGRATIONS_DIR, fileName), content)
  console.log(`✓ 已生成 db/migrations/${fileName}, 改好后跑 pnpm db:snapshot`)
})
