import { describe, expect, it } from 'vitest'
import { KUN_DERIVED_COLUMN_CHECKS } from '../lib/derivedColumns'
import {
  kunDiffObjects,
  kunFilterPrismaDiff,
  kunParseSnapshot,
  kunRenderSnapshot
} from '../lib/drift'
import {
  kunNotxCreatedIndexName,
  kunParseMigrationFile,
  kunPlanMigrations,
  kunSplitNotxStatements,
  kunSplitSqlStatements
} from '../lib/migrationFiles'
import { kunLoadMigrationFiles } from '../lib/runtime'
import type { KunDbObject } from '../lib/drift'
import type { KunLedgerRow, KunMigrationFile } from '../lib/migrationFiles'

const parseOk = (fileName: string, content: string): KunMigrationFile => {
  const parsed = kunParseMigrationFile(fileName, content)
  if (typeof parsed === 'string') {
    throw new Error(parsed)
  }
  return parsed
}

const file = (version: string, phase: 'pre' | 'post' = 'pre') =>
  parseOk(`${version}_m.sql`, `-- phase: ${phase}\nSELECT ${version};`)

const applied = (
  migration: KunMigrationFile,
  overrides: Partial<KunLedgerRow> = {}
): KunLedgerRow => ({
  version: migration.version,
  kind: 'sql',
  checksum: migration.checksum,
  baseline: false,
  ...overrides
})

describe('kunSplitSqlStatements', () => {
  it('只在顶层分号处切分, 并去掉注释', () => {
    expect(
      kunSplitSqlStatements(`
        -- 行注释里的分号; 不算
        SELECT 1; /* 块注释; /* 可嵌套; */ 也不算 */
        SELECT 2
      `)
    ).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('字符串、带引号的标识符与美元引用里的分号和注释符原样保留', () => {
    const statements = kunSplitSqlStatements(
      `SELECT 'a;b--c', 'it''s;', "x;y";
       CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;
       DO $body$ BEGIN PERFORM 1; -- 函数体内的注释
       END $body$;`
    )

    expect(statements).toHaveLength(3)
    expect(statements[0]).toBe(`SELECT 'a;b--c', 'it''s;', "x;y"`)
    expect(statements[1]).toContain('BEGIN RETURN NEW; END;')
    expect(statements[2]).toContain('-- 函数体内的注释')
  })

  it('标识符中间的 $ 不当作美元引用的开头', () => {
    expect(kunSplitSqlStatements('SELECT a$b$c; SELECT 2')).toEqual([
      'SELECT a$b$c',
      'SELECT 2'
    ])
  })

  it('块注释换成一个空格, 不把两侧的词粘在一起', () => {
    expect(kunSplitSqlStatements('SELECT/* x */1')).toEqual(['SELECT 1'])
  })

  it("E'' 串里的反斜杠转义与双写引号都不结束字符串", () => {
    expect(
      kunSplitSqlStatements(String.raw`SELECT E'\'; a''b\'c;'; SELECT 2`)
    ).toEqual([String.raw`SELECT E'\'; a''b\'c;'`, 'SELECT 2'])
    // 以 e 结尾的关键字紧贴普通字符串时, 反斜杠不是转义
    expect(
      kunSplitSqlStatements(String.raw`SELECT x LIKE'a\'; SELECT 2`)
    ).toEqual([String.raw`SELECT x LIKE'a\'`, 'SELECT 2'])
  })
})

describe('kunParseMigrationFile', () => {
  it('从文件名与文件头解析出版本、阶段、模式与超时', () => {
    const parsed = parseOk(
      '0012_add_foo.sql',
      '-- phase: post\n-- lock_timeout: 500ms\n-- statement_timeout: 10min\n-- 说明: 加一列\nALTER TABLE t ADD COLUMN foo int;\n'
    )

    expect(parsed).toMatchObject({
      version: '0012',
      slug: 'add_foo',
      phase: 'post',
      mode: 'tx',
      lockTimeoutMs: 500,
      statementTimeoutMs: 600000
    })
  })

  it('不写指令时默认 pre、lock_timeout 5s、不限 statement_timeout', () => {
    expect(parseOk('0001_a.sql', 'SELECT 1;')).toMatchObject({
      phase: 'pre',
      lockTimeoutMs: 5000,
      statementTimeoutMs: null
    })
  })

  it('notx 文件默认不限 lock_timeout: 并发建索引等待在途事务也受它约束', () => {
    expect(
      parseOk(
        '0001_a.notx.sql',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x);'
      ).lockTimeoutMs
    ).toBe(0)
  })

  it.each([
    ['750ms', 750],
    ['5s', 5000],
    ['2min', 120000]
  ])('超时 %s 换算成 %i 毫秒', (value, expected) => {
    expect(
      parseOk('0001_a.sql', `-- lock_timeout: ${value}\nSELECT 1;`)
        .lockTimeoutMs
    ).toBe(expected)
  })

  it('文件头里的空行不结束文件头, 冒号两侧的空白可有可无', () => {
    expect(
      parseOk('0001_a.sql', '-- 说明\n\n-- phase:post\nSELECT 1;').phase
    ).toBe('post')
    expect(parseOk('0001_a.sql', '-- phase : post\nSELECT 1;').phase).toBe(
      'post'
    )
  })

  it('checksum 覆盖全文, 末尾多一个换行也算改动', () => {
    expect(parseOk('0001_a.sql', 'SELECT 1;').checksum).not.toBe(
      parseOk('0001_a.sql', 'SELECT 1;\n').checksum
    )
  })

  it('checksum 按 LF 规范化后计算, CRLF 与 LF 检出的同一文件结果相同', () => {
    const lf = parseOk('0001_a.sql', '-- phase: post\nSELECT 1;\n')
    const crlf = parseOk('0001_a.sql', '-- phase: post\r\nSELECT 1;\r\n')

    expect(crlf.checksum).toBe(lf.checksum)
    expect(crlf.phase).toBe('post')
    expect(crlf.sql).not.toContain('\r')
    expect(parseOk('0001_a.sql', 'SELECT 2;\n').checksum).not.toBe(lf.checksum)
  })

  it.each([
    ['1_a.sql', 'SELECT 1;'],
    ['0001-a.sql', 'SELECT 1;'],
    ['0001_A.sql', 'SELECT 1;'],
    ['0001_a.txt', 'SELECT 1;']
  ])('拒绝不合约定的文件名 %s', (fileName, content) => {
    expect(kunParseMigrationFile(fileName, content)).toContain('文件名')
  })

  it('拒绝拼错的指令名, 否则 post 迁移会静默按 pre 执行', () => {
    expect(
      kunParseMigrationFile('0001_a.sql', '-- pahse: post\nSELECT 1;')
    ).toContain('未知指令 pahse')
  })

  it.each([
    '-- Phase: post',
    '-- PHASE: post',
    '-- phase：post',
    '-- lock-timeout: 30s',
    '-- Statement_Timeout: 1min'
  ])('拒绝近似写法 %s, 不把它当成普通注释', (line) => {
    expect(kunParseMigrationFile('0001_a.sql', `${line}\nSELECT 1;`)).toContain(
      '指令须写成小写键加半角冒号'
    )
    expect(
      kunParseMigrationFile('0001_a.sql', `SELECT 1;\n${line}\n`)
    ).toContain('必须写在文件头')
  })

  it('拼错的指令名即使冒号后不留空格也拒绝', () => {
    expect(
      kunParseMigrationFile('0001_a.sql', '-- phsae:post\nSELECT 1;')
    ).toContain('未知指令 phsae')
  })

  it('注释里的网址与中文说明不当作指令', () => {
    expect(
      parseOk(
        '0001_a.sql',
        '-- 背景: 见 https://example.com/a\n-- https://example.com/b\nSELECT 1;'
      ).phase
    ).toBe('pre')
  })

  it('拒绝非法的指令值、重复指令与写在文件头之外的指令', () => {
    expect(
      kunParseMigrationFile('0001_a.sql', '-- phase: later\nSELECT 1;')
    ).toContain('phase 只能是')
    expect(
      kunParseMigrationFile('0001_a.sql', '-- lock_timeout: 5\nSELECT 1;')
    ).toContain('lock_timeout 须形如')
    expect(
      kunParseMigrationFile(
        '0001_a.sql',
        '-- phase: pre\n-- phase: post\nSELECT 1;'
      )
    ).toContain('重复')
    expect(
      kunParseMigrationFile('0001_a.sql', 'SELECT 1;\n-- phase: post\n')
    ).toContain('必须写在文件头')
  })

  it.each([
    'BEGIN',
    'begin',
    'COMMIT',
    'ROLLBACK',
    'START TRANSACTION',
    'END',
    'ABORT'
  ])('tx 文件出现顶层 %s 即拒绝', (keyword) => {
    expect(
      kunParseMigrationFile('0001_a.sql', `SELECT 1;\n${keyword};\nSELECT 2;`)
    ).toContain('不要自带事务控制语句')
  })

  it("藏在 E'' 串后面的 COMMIT 同样拒绝", () => {
    expect(
      kunParseMigrationFile(
        '0001_a.sql',
        String.raw`CREATE TABLE t (id int); SELECT E'\'';` +
          '\nCOMMIT;\nSELECT 1;'
      )
    ).toContain('不要自带事务控制语句')
  })

  it('函数体里的 BEGIN / END 不算事务控制', () => {
    const parsed = kunParseMigrationFile(
      '0001_a.sql',
      'CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql;'
    )

    expect(typeof parsed).toBe('object')
  })

  it('拒绝没有任何语句的文件', () => {
    expect(kunParseMigrationFile('0001_a.sql', '-- 只有注释\n')).toContain(
      '没有任何 SQL 语句'
    )
    expect(kunParseMigrationFile('0001_a.notx.sql', '-- 只有注释\n')).toContain(
      '没有任何 SQL 语句'
    )
  })

  it('notx 文件只接受白名单内的并发索引语句', () => {
    expect(
      parseOk(
        '0002_idx.notx.sql',
        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x) WHERE y IS NULL;\nDROP INDEX CONCURRENTLY IF EXISTS b;\nREINDEX INDEX CONCURRENTLY c;\nANALYZE t;'
      ).mode
    ).toBe('notx')
    expect(
      kunParseMigrationFile(
        '0002_idx.notx.sql',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x);\nUPDATE t SET x = 1;'
      )
    ).toContain('notx 文件只允许')
  })
})

describe('kunSplitNotxStatements', () => {
  it.each([
    'CREATE INDEX a ON t (x)',
    'CREATE INDEX CONCURRENTLY a ON t (x)',
    'DROP INDEX CONCURRENTLY a',
    'DROP INDEX IF EXISTS a',
    'ALTER TABLE t ADD COLUMN x int'
  ])('拒绝 %s', (statement) => {
    expect(typeof kunSplitNotxStatements(`${statement};`)).toBe('string')
  })

  it('大小写与换行不影响白名单判定', () => {
    expect(
      kunSplitNotxStatements(
        'create unique index concurrently\n  if not exists a on t (x);'
      )
    ).toHaveLength(1)
  })
})

describe('kunNotxCreatedIndexName', () => {
  it('取出并发建索引语句里的索引名, 其余语句为 null', () => {
    expect(
      kunNotxCreatedIndexName(
        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS patch_vndb_id_solo_key\n  ON patch (vndb_id)'
      )
    ).toBe('patch_vndb_id_solo_key')
    expect(
      kunNotxCreatedIndexName(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "Mixed Idx" ON t (x)'
      )
    ).toBe('"Mixed Idx"')
    expect(
      kunNotxCreatedIndexName('DROP INDEX CONCURRENTLY IF EXISTS a')
    ).toBeNull()
  })
})

describe('kunPlanMigrations', () => {
  const m1 = file('0001')
  const m2 = file('0002')
  const m3 = file('0003', 'post')
  const m4 = file('0004')

  it('待执行的迁移按版本号升序返回, 与传入顺序无关', () => {
    const plan = kunPlanMigrations([m3, m1, m2], [applied(m1)], 'all')

    expect(plan).toEqual({ ok: true, pending: [m2, m3] })
  })

  it('版本号重复即失败', () => {
    const plan = kunPlanMigrations(
      [m1, parseOk('0001_other.sql', 'SELECT 9;')],
      [],
      'all'
    )

    expect(plan).toMatchObject({ ok: false, reason: 'duplicate-version' })
  })

  it('已执行的文件被改写即失败, 登记行同样受检', () => {
    const rewritten = parseOk('0001_m.sql', 'SELECT 1; -- 事后改动\nSELECT 2;')

    expect(kunPlanMigrations([rewritten], [applied(m1)], 'all')).toMatchObject({
      ok: false,
      reason: 'checksum-mismatch'
    })
    expect(
      kunPlanMigrations([rewritten], [applied(m1, { baseline: true })], 'all')
    ).toMatchObject({ ok: false, reason: 'checksum-mismatch' })
  })

  it('台账里的版本找不到文件即失败, 一次性脚本的台账行不算', () => {
    expect(kunPlanMigrations([m2], [applied(m1)], 'all')).toMatchObject({
      ok: false,
      reason: 'applied-file-missing'
    })
    expect(
      kunPlanMigrations(
        [m1],
        [
          applied(m1),
          {
            version: 'script:foo',
            kind: 'script',
            checksum: '',
            baseline: false
          }
        ],
        'all'
      )
    ).toEqual({ ok: true, pending: [] })
  })

  it('待执行版本小于已执行的最大版本即失败 (分支合并造成的乱序)', () => {
    expect(
      kunPlanMigrations([m1, m2, m4], [applied(m1), applied(m4)], 'all')
    ).toMatchObject({ ok: false, reason: 'out-of-order' })
  })

  it('登记行不参与乱序判定: 各环境的既有对象是以任意顺序装出来的', () => {
    const plan = kunPlanMigrations(
      [m1, m2, m4],
      [applied(m1, { baseline: true }), applied(m4, { baseline: true })],
      'all'
    )

    expect(plan).toEqual({ ok: true, pending: [m2] })
  })

  it('--phase pre 只取 pre, post 留给上线之后', () => {
    expect(kunPlanMigrations([m1, m2, m3], [applied(m1)], 'pre')).toEqual({
      ok: true,
      pending: [m2]
    })
    expect(
      kunPlanMigrations([m1, m2, m3], [applied(m1), applied(m2)], 'post')
    ).toEqual({ ok: true, pending: [m3] })
  })

  it('--phase pre 不能越过版本号更小的待执行 post (上次部署的 post 没跑完)', () => {
    expect(
      kunPlanMigrations([m1, m2, m3, m4], [applied(m1), applied(m2)], 'pre')
    ).toMatchObject({ ok: false, reason: 'pending-post-before-pre' })
  })

  it('--phase post 不能越过版本号更小的待执行 pre', () => {
    const m5 = file('0005', 'post')

    expect(
      kunPlanMigrations(
        [m1, m2, m3, m4, m5],
        [applied(m1), applied(m2)],
        'post'
      )
    ).toMatchObject({ ok: false, reason: 'pending-pre-before-post' })
  })

  it('以最靠前的那个待执行 post 为界, 不是最靠后的', () => {
    const m5 = file('0005', 'post')

    expect(
      kunPlanMigrations([m1, m2, m3, m4, m5], [applied(m1), applied(m2)], 'pre')
    ).toMatchObject({ ok: false, reason: 'pending-post-before-pre' })
  })

  it('没有 pre 待执行时, 排在后面的 post 不妨碍 --phase pre 通过', () => {
    expect(
      kunPlanMigrations([m1, m2, m3], [applied(m1), applied(m2)], 'pre')
    ).toEqual({ ok: true, pending: [] })
  })
})

describe('对象快照', () => {
  const objects: KunDbObject[] = [
    {
      kind: 'trigger',
      name: 't.trg',
      definition: 'CREATE TRIGGER trg AFTER INSERT ON public.t'
    },
    {
      kind: 'function',
      name: 'f()',
      definition:
        'CREATE OR REPLACE FUNCTION public.f()\nAS $function$\nBEGIN\n  RETURN NULL; -- 注释\nEND;\n$function$\n'
    },
    {
      kind: 'index',
      name: 'i',
      definition:
        'CREATE UNIQUE INDEX i ON public.t USING btree (x) WHERE (y IS NULL)'
    }
  ]

  it('渲染后再解析得到同一组对象, 顺序为 函数 → 触发器 → 索引', () => {
    const parsed = kunParseSnapshot(kunRenderSnapshot(objects))

    expect(parsed.map((object) => object.name)).toEqual(['f()', 't.trg', 'i'])
    expect(kunDiffObjects(objects, parsed)).toEqual([])
    expect(kunDiffObjects(parsed, objects)).toEqual([])
  })

  it('渲染结果与输入顺序无关', () => {
    expect(kunRenderSnapshot([...objects].reverse())).toBe(
      kunRenderSnapshot(objects)
    )
  })

  it('报告缺失、定义不同与多余的对象', () => {
    const actual: KunDbObject[] = [
      {
        ...objects[0],
        definition: 'CREATE TRIGGER trg AFTER DELETE ON public.t'
      },
      objects[1],
      { kind: 'trigger', name: 't.legacy_trg', definition: 'CREATE TRIGGER x' }
    ]

    expect(kunDiffObjects(objects, actual)).toEqual([
      '定义不同 trigger t.trg',
      '缺失 index i',
      '多余 trigger t.legacy_trg'
    ])
  })
})

describe('kunFilterPrismaDiff', () => {
  const allowlist =
    '-- 已知噪音\nDROP INDEX "patch_released_idx";\nCREATE INDEX "patch_released_idx" ON "patch"("released" text_pattern_ops);\n'

  it('只剩白名单噪音时两项皆空', () => {
    expect(
      kunFilterPrismaDiff(
        '-- DropIndex\nDROP INDEX "patch_released_idx";\n\n-- CreateIndex\nCREATE INDEX "patch_released_idx" ON "patch"("released" text_pattern_ops);\n',
        allowlist
      )
    ).toEqual({ unexpected: [], stale: [] })
  })

  it('白名单之外的语句与不再出现的白名单条目分别报告', () => {
    expect(
      kunFilterPrismaDiff(
        'DROP INDEX "patch_released_idx";\nALTER TABLE "patch" ADD COLUMN "foo" INTEGER;',
        allowlist
      )
    ).toEqual({
      unexpected: ['ALTER TABLE "patch" ADD COLUMN "foo" INTEGER'],
      stale: [
        'CREATE INDEX "patch_released_idx" ON "patch"("released" text_pattern_ops)'
      ]
    })
  })

  it('语句原样返回, 不改动字符串字面量里的空白', () => {
    expect(
      kunFilterPrismaDiff(
        `ALTER TABLE "t" ADD COLUMN "c" TEXT NOT NULL DEFAULT 'a  b';`,
        ''
      ).unexpected
    ).toEqual([`ALTER TABLE "t" ADD COLUMN "c" TEXT NOT NULL DEFAULT 'a  b'`])
  })

  it('空差异 (只有注释) 时白名单条目全部判为过期', () => {
    expect(
      kunFilterPrismaDiff('-- This is an empty migration.', allowlist).stale
    ).toHaveLength(2)
  })
})

describe('db/migrations 现有文件', () => {
  const files = kunLoadMigrationFiles()

  it('全部可解析, 版本号从 0001 起连续', () => {
    expect(files.map((migration) => Number(migration.version))).toEqual(
      files.map((_, index) => index + 1)
    )
    expect(kunPlanMigrations(files, [], 'all')).toMatchObject({ ok: true })
  })

  it('首批迁移 (0001–0007) 可以按 pre → post 分阶段执行', () => {
    const batch = files.filter((migration) => migration.version <= '0007')
    const versions = (plan: ReturnType<typeof kunPlanMigrations>) =>
      plan.ok ? plan.pending.map((migration) => migration.version) : plan

    const pre = kunPlanMigrations(batch, [], 'pre')
    expect(versions(pre)).toEqual(['0001', '0002', '0003'])

    const post = kunPlanMigrations(
      batch,
      pre.ok ? pre.pending.map((migration) => applied(migration)) : [],
      'post'
    )
    expect(versions(post)).toEqual(['0004', '0005', '0006', '0007'])
  })

  it('released_sort 只读对账的表达式与触发器函数体逐字一致', () => {
    const normalize = (sql: string) =>
      sql.replaceAll('NEW.', '').replace(/\s+/g, ' ')
    const triggerSource = normalize(
      files.findLast((migration) =>
        migration.sql.includes('FUNCTION patch_released_sort_trg()')
      )!.sql
    )
    const condition = /IF (released ~ .+?) THEN/.exec(triggerSource)![1]
    const expression = /released_sort := (.+?);/.exec(triggerSource)![1]
    const checkSql = normalize(
      KUN_DERIVED_COLUMN_CHECKS.find(
        (check) => check.column === 'patch.released_sort'
      )!.sql
    )

    expect(checkSql).toContain(`CASE WHEN ${condition} THEN ${expression} END`)
  })
})
