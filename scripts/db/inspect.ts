import 'dotenv/config'
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { parseArgs } from 'util'
import { kunPlanMigrations } from './lib/migrationFiles'
import {
  KUN_SNAPSHOT_PATH,
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
import type { Client } from 'pg'

// 只读盘点: 打印一个库的实际状态, 用来决定该环境哪些迁移登记为已执行。
// 不写库、不建台账, 发现不一致也不报错退出 —— 它只负责把事实摆出来。
//   pnpm db:inspect            版本、台账、库级对象 (对照快照)、表结构差异
//   pnpm db:inspect --counts   另做派生列对账与数据前置检查 (全表聚合, 低峰执行)

// 迁移与待执行一次性脚本的数据前置, 期望全为 0
const DATA_PRECONDITIONS: { label: string; sql: string }[] = [
  {
    label: 'patch_alias 重复组 (0005 会清掉)',
    sql: `SELECT COUNT(*)::int AS n FROM (
            SELECT 1 FROM "patch_alias" GROUP BY patch_id, name HAVING COUNT(*) > 1
          ) t`
  },
  {
    label: '单独 vndb_id 重复组 (非 0 时 0006 会停下)',
    sql: `SELECT COUNT(*)::int AS n FROM (
            SELECT 1 FROM "patch"
            WHERE vndb_id IS NOT NULL AND vndb_relation_id IS NULL
            GROUP BY vndb_id HAVING COUNT(*) > 1
          ) t`
  },
  {
    label: '单独 vndb_relation_id 重复组 (非 0 时 0006 会停下)',
    sql: `SELECT COUNT(*)::int AS n FROM (
            SELECT 1 FROM "patch"
            WHERE vndb_relation_id IS NOT NULL AND vndb_id IS NULL
            GROUP BY vndb_relation_id HAVING COUNT(*) > 1
          ) t`
  },
  {
    label: '仍存明文两步验证备用码的用户 (hashTwoFactorBackupCodes 未跑完)',
    sql: `SELECT COUNT(*)::int AS n FROM "user" u
          WHERE EXISTS (
            SELECT 1 FROM unnest(u.two_factor_backup) code WHERE code NOT LIKE 'h1:%'
          )`
  }
]

const section = (title: string) => console.log(`\n## ${title}`)

const md5 = (text: string) => createHash('md5').update(text).digest('hex')

const printRows = async (client: Client, sql: string) => {
  const { rows } = await client.query(sql)
  for (const row of rows) {
    console.log(`  ${Object.values(row).join(' | ')}`)
  }
  if (rows.length === 0) {
    console.log('  (无)')
  }
}

kunRunCli(async () => {
  const { values } = parseArgs({
    options: { counts: { type: 'boolean', default: false } }
  })

  const client = await kunConnect(
    process.env.KUN_DATABASE_URL,
    'KUN_DATABASE_URL',
    { readOnly: true }
  )
  try {
    section('环境')
    await printRows(
      client,
      `SELECT 'server_version=' || current_setting('server_version') AS a,
              'TimeZone=' || current_setting('TimeZone') AS b,
              'database=' || current_database() AS c,
              'user=' || current_user AS d,
              'search_path=' || current_setting('search_path') AS e`
    )
    // 台账放在 kun_meta schema, 建它需要库级 CREATE 权限, 应用用户不一定有
    await printRows(
      client,
      `SELECT '能否建 kun_meta: ' || CASE
         WHEN to_regnamespace('kun_meta') IS NOT NULL THEN
           '已存在, 当前用户' || CASE WHEN has_schema_privilege(current_user, 'kun_meta', 'CREATE')
                                   THEN '可以' ELSE '不能' END || '在其中建表'
         WHEN has_database_privilege(current_user, current_database(), 'CREATE') THEN '是'
         ELSE '否, 须由库的属主或超级用户先执行: CREATE SCHEMA kun_meta AUTHORIZATION "'
              || current_user || '";'
       END`
    )

    section('schema (系统 schema 除外) 与扩展')
    await printRows(
      client,
      `SELECT 'schema ' || nspname FROM pg_namespace
       WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
       UNION ALL
       SELECT 'extension ' || extname || ' ' || extversion FROM pg_extension
       ORDER BY 1`
    )

    section('迁移台账 kun_meta.schema_migration')
    const ledger = await kunReadLedger(client)
    for (const row of ledger) {
      console.log(
        `  ${row.version} ${row.kind} ${row.phase} ${row.baseline ? '登记' : '执行'} ${row.applied_at.toISOString()} ${row.note ?? ''}`
      )
    }
    const plan = kunPlanMigrations(kunLoadMigrationFiles(), ledger, 'all')
    console.log(
      plan.ok
        ? `  待执行 ${plan.pending.length} 个: ${plan.pending.map((file) => file.version).join(' ') || '(无)'}`
        : `  ${plan.reason}: ${plan.detail}`
    )

    section('库级对象 (Prisma schema 看不见的): 类型 | 名称 | 定义 md5')
    const objects = await kunExportObjects(client)
    for (const object of objects) {
      console.log(
        `  ${object.kind} | ${object.name} | ${md5(object.definition)}`
      )
    }
    if (objects.length === 0) {
      console.log('  (无)')
    }

    if (existsSync(KUN_SNAPSHOT_PATH)) {
      section('库级对象对照 db/objects.snapshot.sql')
      const problems = kunCheckObjectDrift(objects)
      for (const problem of problems) {
        console.log(`  ${problem}`)
      }
      if (problems.length === 0) {
        console.log(`  全部一致 (${objects.length} 个对象)`)
      }
      // 定义不同的对象把实际定义打全, 据此判断装的是哪一代
      for (const object of objects) {
        const key = `${object.kind} ${object.name}`
        if (problems.includes(`定义不同 ${key}`)) {
          console.log(`\n-- 实际定义: ${key}\n${object.definition}`)
        }
      }
    }

    section('INVALID 索引')
    const invalid = await kunFindInvalidIndexes(client)
    console.log(`  ${invalid.join(' ') || '(无)'}`)

    section('表')
    await printRows(
      client,
      `SELECT name || ' ' || CASE WHEN to_regclass('public.' || name) IS NULL THEN '缺失' ELSE '存在' END
       FROM unnest(ARRAY['admin_setting', 'search_outbox', 's3_deletion_outbox']) AS name
       UNION ALL
       SELECT 'patch_resource_link.' || column_name || ' ' || data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'patch_resource_link'
         AND column_name IN ('created', 'updated')
       UNION ALL
       SELECT 'public 下表 ' || COUNT(*) FILTER (WHERE relkind IN ('r', 'p'))
              || ' 张, 视图 ' || COUNT(*) FILTER (WHERE relkind IN ('v', 'm')) || ' 个'
       FROM pg_class WHERE relnamespace = 'public'::regnamespace`
    )

    section('prisma migrate diff (现网 → prisma/schema) 原始输出')
    const drift = kunCheckPrismaDrift()
    console.log(drift.raw.trim() || '(空)')
    console.log(
      `\n  扣除白名单后剩余 ${drift.unexpected.length} 条, 白名单未再出现 ${drift.stale.length} 条`
    )

    if (values.counts) {
      section('派生列对账: 不一致行数, 期望全为 0')
      for (const result of await kunCountDerivedMismatches(client)) {
        console.log(
          `  ${result.column} ${result.mismatched ?? `查询失败: ${result.error}`}`
        )
      }

      // 逐项执行: 某张表或某一列在这个环境不存在时, 其余各项照常给出数字
      section('数据前置, 期望全为 0')
      for (const check of DATA_PRECONDITIONS) {
        const value = await client.query(check.sql).then(
          ({ rows }) => rows[0].n,
          (error) => `查询失败: ${error.message}`
        )
        console.log(`  ${check.label}: ${value}`)
      }
    }
  } finally {
    await client.end()
  }
})
