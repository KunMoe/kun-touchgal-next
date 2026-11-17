import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest'
import { kunCountPlannedMigrations } from '../../deployChain'
import { kunParseMigrationFile } from '../lib/migrationFiles'
import {
  KUN_MIGRATIONS_DIR,
  kunConnect,
  kunConnectScratch,
  kunFindInvalidIndexes,
  kunPrepareLedger,
  kunReadLedger,
  kunResetScratch,
  kunRunMigrations
} from '../lib/runtime'
import type { Client } from 'pg'
import type { KunMigrationFile } from '../lib/migrationFiles'

// 执行器在真实 PostgreSQL 上的行为。只在给了回放库 (KUN_DB_SCRATCH_URL, 会被反复清空)
// 时运行: CI 的 db-replay job 带着它跑, 本地的 pnpm test 没有这个变量, 整组跳过。
//   KUN_DB_SCRATCH_URL=postgresql://... pnpm exec vitest run scripts/db

const scratchUrl = process.env.KUN_DB_SCRATCH_URL

const migration = (fileName: string, content: string): KunMigrationFile => {
  const parsed = kunParseMigrationFile(fileName, content)
  if (typeof parsed === 'string') {
    throw new Error(parsed)
  }
  return parsed
}

describe.skipIf(!scratchUrl)('迁移执行器 (实库)', () => {
  let client: Client
  const extraClients: Client[] = []

  const connectExtra = async (url = scratchUrl) => {
    const extra = await kunConnect(url, 'KUN_DB_SCRATCH_URL')
    extraClients.push(extra)
    return extra
  }
  const ledgerVersions = async () =>
    (await kunReadLedger(client)).map((row) => row.version)
  const exists = async (name: string) =>
    (await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [name]))
      .rows[0].ok as boolean

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    client = await kunConnectScratch()
  })

  beforeEach(async () => {
    await client.query('SELECT pg_advisory_unlock_all()')
    await kunResetScratch(client)
  })

  afterEach(async () => {
    await Promise.all(extraClients.splice(0).map((extra) => extra.end()))
  })

  afterAll(async () => {
    await kunResetScratch(client)
    await client.end()
    vi.restoreAllMocks()
  })

  describe('事务迁移', () => {
    it('按版本号顺序执行并各写一行台账, 重跑不再执行', async () => {
      const files = [
        migration('0002_b.sql', 'ALTER TABLE t ADD COLUMN y int;'),
        migration('0001_a.sql', 'CREATE TABLE t (x int);')
      ]

      expect(await kunRunMigrations(client, files, 'all')).toBe(2)
      expect(await kunRunMigrations(client, files, 'all')).toBe(0)
      expect(await ledgerVersions()).toEqual(['0001', '0002'])
    })

    it('中途失败时整个文件回滚, 不写台账, 报错带文件内行号', async () => {
      const files = [
        migration(
          '0001_a.sql',
          '-- 说明\nCREATE TABLE t (x int);\nSELECT 1 FROM no_such_table;'
        )
      ]

      await expect(kunRunMigrations(client, files, 'all')).rejects.toThrow(
        /no_such_table.*第 3 行/
      )
      expect(await exists('public.t')).toBe(false)
      expect(await ledgerVersions()).toEqual([])
    })

    it('拿不到锁时整个文件重试, 锁释放后成功', async () => {
      await client.query('CREATE TABLE t (x int)')
      const blocker = await connectExtra()
      await blocker.query('BEGIN; LOCK TABLE t IN ACCESS EXCLUSIVE MODE')
      const release = setTimeout(() => void blocker.query('COMMIT'), 700)

      try {
        await kunRunMigrations(
          client,
          [
            migration(
              '0001_a.sql',
              '-- lock_timeout: 500ms\nALTER TABLE t ADD COLUMN y int;'
            )
          ],
          'all'
        )
      } finally {
        clearTimeout(release)
      }

      expect(await ledgerVersions()).toEqual(['0001'])
    })

    it('三次都拿不到锁就失败, 不留台账', async () => {
      await client.query('CREATE TABLE t (x int)')
      const blocker = await connectExtra()
      await blocker.query('BEGIN; LOCK TABLE t IN ACCESS EXCLUSIVE MODE')

      await expect(
        kunRunMigrations(
          client,
          [
            migration(
              '0001_a.sql',
              '-- lock_timeout: 100ms\nALTER TABLE t ADD COLUMN y int;'
            )
          ],
          'all'
        )
      ).rejects.toMatchObject({ code: '55P03' })
      await blocker.query('ROLLBACK')
      expect(await ledgerVersions()).toEqual([])
    })

    it('不写 statement_timeout 时不继承会话上已有的限制', async () => {
      await client.query('SET statement_timeout = 50')
      try {
        await kunRunMigrations(
          client,
          [migration('0001_a.sql', 'SELECT pg_sleep(0.3);')],
          'all'
        )
      } finally {
        await client.query('RESET statement_timeout')
      }

      expect(await ledgerVersions()).toEqual(['0001'])
    })
  })

  describe('并发索引迁移', () => {
    const uniqueIndex = migration(
      '0001_idx.notx.sql',
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_x_key ON t (x);'
    )

    it('建唯一索引失败时删掉 INVALID 残留, 不写台账; 修好数据后重跑成功', async () => {
      await client.query(
        'CREATE TABLE t (x int); INSERT INTO t VALUES (1), (1)'
      )

      await expect(
        kunRunMigrations(client, [uniqueIndex], 'all')
      ).rejects.toMatchObject({ code: '23505' })
      expect(await exists('public.t_x_key')).toBe(false)
      expect(await ledgerVersions()).toEqual([])

      await client.query('DELETE FROM t')
      await kunRunMigrations(client, [uniqueIndex], 'all')
      expect(await kunFindInvalidIndexes(client)).toEqual([])
      expect(await ledgerVersions()).toEqual(['0001'])
    })

    it('目标索引是上次留下的 INVALID 残留时先删再建, 不被 IF NOT EXISTS 骗过', async () => {
      await client.query(
        'CREATE TABLE t (x int); INSERT INTO t VALUES (1), (1)'
      )
      await client
        .query('CREATE UNIQUE INDEX CONCURRENTLY t_x_key ON t (x)')
        .catch(() => {})
      expect(await kunFindInvalidIndexes(client)).toEqual(['t_x_key'])
      await client.query('DELETE FROM t')

      await kunRunMigrations(client, [uniqueIndex], 'all')

      expect(await kunFindInvalidIndexes(client)).toEqual([])
      expect(await exists('public.t_x_key')).toBe(true)
    })

    it('REINDEX 失败留下的 _ccnew 索引同样被清掉', async () => {
      await client.query(`
        CREATE TABLE t (x int);
        INSERT INTO t VALUES (1);
        CREATE FUNCTION fail_when_asked(v int) RETURNS int IMMUTABLE AS $$
        BEGIN
          IF current_setting('kun.fail', true) = 'on' THEN
            RAISE EXCEPTION 'boom';
          END IF;
          RETURN v;
        END $$ LANGUAGE plpgsql;
        CREATE INDEX t_expr_idx ON t (fail_when_asked(x));
        SET kun.fail = 'on';
      `)

      try {
        await expect(
          kunRunMigrations(
            client,
            [
              migration(
                '0001_re.notx.sql',
                'REINDEX INDEX CONCURRENTLY t_expr_idx;'
              )
            ],
            'all'
          )
        ).rejects.toThrow(/boom/)
      } finally {
        await client.query('RESET kun.fail')
      }
      expect(await kunFindInvalidIndexes(client)).toEqual([])
      expect(await exists('public.t_expr_idx')).toBe(true)
      expect(await ledgerVersions()).toEqual([])
    })

    it('不动与本次语句无关的 INVALID 索引', async () => {
      await client.query(
        'CREATE TABLE t (x int); CREATE TABLE u (x int); INSERT INTO u VALUES (1), (1)'
      )
      await client
        .query('CREATE UNIQUE INDEX CONCURRENTLY u_x_key ON u (x)')
        .catch(() => {})

      await kunRunMigrations(client, [uniqueIndex], 'all')

      expect(await kunFindInvalidIndexes(client)).toEqual(['u_x_key'])
    })
  })

  describe('台账与并发', () => {
    it('另一个执行器持有通告锁时立即失败, 不排队', async () => {
      await kunPrepareLedger(client)
      const other = await connectExtra()

      await expect(kunRunMigrations(other, [], 'all')).rejects.toThrow(
        /另一个迁移执行器正在这个库上运行/
      )
    })

    it('没有建 schema 的权限时给出要属主执行的语句, 建好之后可用', async ({
      skip
    }) => {
      const { rows } = await client.query(
        'SELECT rolsuper FROM pg_roles WHERE rolname = current_user'
      )
      if (!rows[0].rolsuper) {
        skip()
      }
      // kunResetScratch 建好了 kun_meta, 这里要的是「还没有 kun_meta」的库
      await client.query(`
        DROP SCHEMA kun_meta CASCADE;
        DROP ROLE IF EXISTS kun_test_app;
        CREATE ROLE kun_test_app LOGIN PASSWORD 'kun_test_app';
      `)
      const appUrl = new URL(scratchUrl!)
      appUrl.username = 'kun_test_app'
      appUrl.password = 'kun_test_app'

      try {
        const app = await connectExtra(appUrl.toString())
        await expect(kunPrepareLedger(app)).rejects.toThrow(
          /CREATE SCHEMA kun_meta AUTHORIZATION "kun_test_app"/
        )

        await client.query('CREATE SCHEMA kun_meta AUTHORIZATION kun_test_app')
        await kunPrepareLedger(app)
        expect(await exists('kun_meta.schema_migration')).toBe(true)
      } finally {
        await Promise.all(extraClients.splice(0).map((extra) => extra.end()))
        await client.query(
          'DROP SCHEMA IF EXISTS kun_meta CASCADE; DROP ROLE kun_test_app'
        )
      }
    })

    it('只读连接上的写入被库拒绝', async () => {
      const readOnly = await kunConnect(scratchUrl, 'KUN_DB_SCRATCH_URL', {
        readOnly: true
      })
      extraClients.push(readOnly)

      await expect(
        readOnly.query('CREATE TABLE t (x int)')
      ).rejects.toMatchObject({ code: '25006' })
    })

    // 对回放库执行 db:migrate 命令本身; 失败时 stderr 非空
    const migrateCli = (args: string[]) => {
      try {
        const stdout = execFileSync(
          'node_modules/.bin/esno',
          [fileURLToPath(new URL('../migrate.ts', import.meta.url)), ...args],
          {
            stdio: 'pipe',
            encoding: 'utf8',
            env: { ...process.env, KUN_DATABASE_URL: scratchUrl }
          }
        )
        return { stdout, stderr: '' }
      } catch (error) {
        const failure = error as { stdout: string; stderr: string }
        return { stdout: failure.stdout, stderr: failure.stderr }
      }
    }

    it('--mark-applied 连着 --dry-run 时报错退出, 不写台账', async () => {
      const { stderr } = migrateCli([
        '--mark-applied',
        '0001',
        '--reason',
        'x',
        '--dry-run'
      ])

      expect(stderr).toContain('--mark-applied 不能与')
      expect(await exists('kun_meta.schema_migration')).toBe(false)
    })

    it.each([[[]], [['--dry-run']], [['--phase', 'pre']]])(
      '库里已有表而台账为空时 db:migrate %j 拒绝执行, 不建台账也不建表',
      async (args) => {
        await client.query('CREATE TABLE "user" (id int)')

        expect(migrateCli(args).stderr).toContain('不在台账里')
        expect(await exists('kun_meta.schema_migration')).toBe(false)
        expect(await exists('public.patch')).toBe(false)
      }
    )

    it('只登记了后面的版本、基线不在台账里时同样拒绝', async () => {
      await client.query('CREATE TABLE "user" (id int)')
      migrateCli(['--mark-applied', '0002', '--reason', 'test'])

      expect(migrateCli([]).stderr).toContain('基线迁移 0001 不在台账里')
      expect(await ledgerVersions()).toEqual(['0002'])
    })

    it('空库和登记过基线的库不受这道保护影响', async () => {
      expect(migrateCli(['--dry-run']).stderr).toBe('')

      await client.query('CREATE TABLE "user" (id int)')
      expect(
        migrateCli(['--mark-applied', '0001', '--reason', 'test']).stderr
      ).toBe('')
      expect(migrateCli(['--dry-run']).stderr).toBe('')
    })

    // deploy:build 靠 --dry-run 的汇总行判断有没有待执行的 post 迁移, 从而决定 push 排在哪
    it('--dry-run 的汇总行能被部署链读出待执行的个数', async () => {
      expect(kunCountPlannedMigrations(migrateCli(['--dry-run']).stdout)).toBe(
        readdirSync(KUN_MIGRATIONS_DIR).length
      )

      expect(migrateCli([]).stderr).toBe('')
      expect(
        kunCountPlannedMigrations(
          migrateCli(['--phase', 'post', '--dry-run']).stdout
        )
      ).toBe(0)
    })
  })

  describe('回放库保护', () => {
    it('没打过标记又有表的库拒绝清空', async () => {
      await client.query('DROP SCHEMA kun_meta CASCADE; CREATE TABLE t (x int)')

      await expect(kunConnectScratch()).rejects.toThrow(/拒绝清空/)
      expect(await exists('public.t')).toBe(true)
    })

    it('打过标记但表里有数据的库拒绝清空: 它后来被当成真库用过', async () => {
      await client.query('CREATE TABLE t (x int); INSERT INTO t VALUES (1)')

      await expect(kunConnectScratch()).rejects.toThrow(/里有数据/)
    })

    it('打过标记但 public 之外还有表的库拒绝清空', async () => {
      await client.query('CREATE SCHEMA app; CREATE TABLE app.users (id int)')

      try {
        await expect(kunConnectScratch()).rejects.toThrow(/app\.users/)
      } finally {
        await client.query('DROP SCHEMA app CASCADE')
      }
    })

    it('与 KUN_DATABASE_URL 是同一个库时拒绝, 按库身份而不是 URL 字面', async () => {
      const original = process.env.KUN_DATABASE_URL
      const sameDatabase = new URL(scratchUrl!)
      sameDatabase.searchParams.set('schema', 'public')
      process.env.KUN_DATABASE_URL = sameDatabase.toString()

      try {
        await expect(kunConnectScratch()).rejects.toThrow(/同一个库/)
      } finally {
        if (original === undefined) {
          delete process.env.KUN_DATABASE_URL
        } else {
          process.env.KUN_DATABASE_URL = original
        }
      }
    })

    it('打过标记、只有空表的库可以再次用作回放库', async () => {
      await client.query('CREATE TABLE t (x int)')

      const again = await kunConnectScratch()
      extraClients.push(again)
    })
  })
})
