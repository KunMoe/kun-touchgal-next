import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'
import { parseArgs } from 'util'
import { kunRenderSnapshot } from './lib/drift'
import {
  KUN_SNAPSHOT_PATH,
  kunConnectScratch,
  kunExportObjects,
  kunLoadMigrationFiles,
  kunReplayIntoScratch,
  kunRunCli
} from './lib/runtime'

// 在回放库 (KUN_DB_SCRATCH_URL, 会被清空) 里从空库回放全部迁移, 导出 Prisma schema
// 看不见的库级对象, 写入 db/objects.snapshot.sql。
//   pnpm db:snapshot           新增或修改迁移之后重新生成, 与迁移一起提交
//   pnpm db:snapshot --check   只比对不写文件, 不一致时以非零码退出 (CI 使用)

kunRunCli(async () => {
  const { values } = parseArgs({
    options: { check: { type: 'boolean', default: false } }
  })

  const client = await kunConnectScratch()
  let snapshot: string
  try {
    await kunReplayIntoScratch(client, kunLoadMigrationFiles())
    snapshot = kunRenderSnapshot(await kunExportObjects(client))
  } finally {
    await client.end()
  }

  if (!values.check) {
    writeFileSync(KUN_SNAPSHOT_PATH, snapshot)
    console.log('✓ 已写入 db/objects.snapshot.sql')
    return
  }
  const committed = readFileSync(KUN_SNAPSHOT_PATH, 'utf8').replace(
    /\r\n/g,
    '\n'
  )
  if (committed !== snapshot) {
    throw new Error(
      'db/objects.snapshot.sql 与回放结果不一致: 改了迁移之后要跑 pnpm db:snapshot 并提交'
    )
  }
  console.log('✓ db/objects.snapshot.sql 与回放结果一致')
})
