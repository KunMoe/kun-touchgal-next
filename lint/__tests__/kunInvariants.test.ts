import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import eslintConfig from '../../eslint.config.mjs'
import {
  CONTENT_RELATION_FIELDS,
  KUN_INVARIANTS,
  createKunInvariantRule
} from '../kunInvariants.mjs'
import { kunWithoutTypeInfo } from '../kunTypeAware.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const SELF = 'lint/__tests__/kunInvariants.test.ts'
// ESLint 首次加载整套配置与插件要数秒
const TIMEOUT = 60_000

// 样例路径都是虚构的 (磁盘上没有这些文件), 类型服务找不到它们, 开着类型块连解析都过不了。
// 不变量规则只看语法, 所以本文件的每个 ESLint 实例都把类型块关掉 (见 lint/kunTypeAware.mjs)
const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfig: [kunWithoutTypeInfo]
})

const reportsOf = async (
  linter: ESLint,
  code: string,
  file: string,
  ruleId: string
) => {
  const [result] = await linter.lintText(`${code}\n`, { filePath: file })
  return result.messages.filter((message) => message.ruleId === ruleId)
}

// 已跟踪与未跟踪 (未被 gitignore) 的非 md 文件; 无命中时 git grep 以 1 退出
const grepRepo = (needle: string) => {
  try {
    return execFileSync(
      'git',
      [
        'grep',
        '--untracked',
        '-n',
        '-I',
        '-F',
        '-e',
        needle,
        '--',
        '.',
        ':!*.md',
        `:!${SELF}`
      ],
      { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
    )
      .split('\n')
      .filter(Boolean)
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      return []
    }
    throw error
  }
}

describe('kun 不变量注册表', { timeout: TIMEOUT }, () => {
  it('id 唯一且都以 inv- 开头', () => {
    const ids = KUN_INVARIANTS.map((inv) => inv.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^inv-[a-z]+-\d+$/.test(id))).toBe(true)
  })

  it.each(KUN_INVARIANTS)(
    '$id: bad 样例必报, good 样例 0 报',
    async ({ id, examples }) => {
      expect(examples.bad.length).toBeGreaterThan(0)
      for (const bad of examples.bad) {
        const reports = await reportsOf(eslint, bad, examples.file, `kun/${id}`)
        expect(reports.length, `bad 样例未报出: ${bad}`).toBeGreaterThan(0)
        expect(reports[0].message).toContain(id)
      }
      for (const good of examples.good) {
        const reports = await reportsOf(
          eslint,
          good,
          examples.file,
          `kun/${id}`
        )
        expect(reports, `good 样例被误报: ${good}`).toEqual([])
      }
    }
  )

  // 防止后来的配置块把某条不变量关掉或降级
  it.each(KUN_INVARIANTS)(
    '$id 在真实配置下是 error',
    async ({ id, examples }) => {
      const config = await eslint.calculateConfigForFile(examples.file)
      expect(config.rules[`kun/${id}`]?.[0]).toBe(2)
    }
  )

  // inv-content-05/06 按字段名认嵌套写: 名单须等于 schema 里指向三张内容表的关系字段名,
  // 且这些名字不能在别的模型上指向别的表 (否则同名的非内容关系会被误报, 或得另想办法区分)
  it('内容表关系字段名单与 prisma/schema 一致且无歧义', () => {
    const schemaDir = join(repoRoot, 'prisma/schema')
    const schema = readdirSync(schemaDir)
      .filter((file) => file.endsWith('.prisma'))
      .map((file) => readFileSync(join(schemaDir, file), 'utf-8'))
      .join('\n')
    const fields = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)]
      .flatMap(([, model, body]) =>
        body.split('\n').map((line) => {
          const match = line.split('//')[0].match(/^\s*(\w+)\s+(\w+)/)
          return match ? { model, name: match[1], type: match[2] } : null
        })
      )
      .filter((field) => field !== null)
    const content = new Set(['patch_comment', 'patch_rating', 'patch_resource'])
    const names = [
      ...new Set(
        fields.filter((field) => content.has(field.type)).map((f) => f.name)
      )
    ].sort()

    expect(names).toEqual([...CONTENT_RELATION_FIELDS].sort())
    expect(
      fields
        .filter(
          (field) => names.includes(field.name) && !content.has(field.type)
        )
        .map((field) => `${field.model}.${field.name}: ${field.type}`)
    ).toEqual([])
  })

  // 测试做不了生产写入, 却常要 mock / 断言这些方法 (inv-content-05/06), 输入夹具也常写
  // { ...baseInput, role: 2 } (inv-authz-03), 构造操作者要用 kunTestActor (inv-authz-04),
  // 拼 Cookie 头要写镜像 cookie 的名字 (inv-viewer-02), 路由与页面读取器要放在一起比 (inv-viewer-01),
  // 索引查询的测试要直接调 queryGalgameIds (inv-search-02);
  // 示例路径不在 __tests__ 下, 上面照常执行
  it.each([
    'inv-content-05',
    'inv-content-06',
    'inv-authz-03',
    'inv-authz-04',
    'inv-viewer-01',
    'inv-viewer-02',
    'inv-search-02'
  ])('%s 不管 __tests__ 下的文件', async (id) => {
    const inv = KUN_INVARIANTS.find((item) => item.id === id)
    expect(inv?.examples.file).not.toContain('__tests__')
    for (const bad of inv?.examples.bad ?? []) {
      const reports = await reportsOf(
        eslint,
        bad,
        'app/api/__tests__/kunInvariantExample.test.ts',
        `kun/${id}`
      )
      expect(reports, bad).toEqual([])
    }
  })

  // KunActor 只在服务端流动: 客户端的表单与 store 更新 ({ ...user, role }) 不归这条管。
  // 作用域收窄或放宽都会让这条变红
  it('inv-authz-03 只在服务端目录执法', async () => {
    const inv = KUN_INVARIANTS.find((item) => item.id === 'inv-authz-03')
    const [bad] = inv?.examples.bad ?? []
    const reportsAt = (file: string) =>
      reportsOf(eslint, bad, file, 'kun/inv-authz-03')

    for (const file of [
      'components/kun/KunInvariantExample.tsx',
      'store/kunInvariantExample.ts',
      'hooks/kunInvariantExample.ts'
    ]) {
      expect(await reportsAt(file), file).toEqual([])
    }
    for (const file of [
      'app/api/kunInvariantExample.ts',
      'server/kunInvariantExample.ts',
      'middleware/kunInvariantExample.ts',
      'utils/actions/kunInvariantExample.ts',
      'lib/kunInvariantExample.ts'
    ]) {
      expect((await reportsAt(file)).length, file).toBeGreaterThan(0)
    }
  })

  // app/api 之外的 Route Handler (OIDC) 同样不在渲染过程里; 页面与页面读取器正是 fromHeaders 的用户
  it('inv-viewer-01 管 Route Handler 与 app/api, 不管页面', async () => {
    const inv = KUN_INVARIANTS.find((item) => item.id === 'inv-viewer-01')
    const [bad] = inv?.examples.bad ?? []
    const reportsAt = (file: string) =>
      reportsOf(eslint, bad, file, 'kun/inv-viewer-01')

    for (const file of [
      'app/api/home/service.ts',
      'app/oidc/interaction/[uid]/confirm/route.ts',
      'app/feed/route.tsx',
      'app/opengraph-image.tsx',
      'app/sitemap.ts'
    ]) {
      expect((await reportsAt(file)).length, file).toBeGreaterThan(0)
    }
    for (const file of [
      'app/page.tsx',
      'app/actions.ts',
      'app/admin/layout.tsx',
      'utils/actions/kunInvariantExample.ts'
    ]) {
      expect(await reportsAt(file), file).toEqual([])
    }
  })

  // 读这两个 cookie 的代码可以写在任何会在服务端执行的文件里, 包括 components 下的服务端组件
  it('inv-viewer-02 全仓执法, 只放过 context.ts', async () => {
    const inv = KUN_INVARIANTS.find((item) => item.id === 'inv-viewer-02')
    const [bad] = inv?.examples.bad ?? []
    const reportsAt = (file: string) =>
      reportsOf(eslint, bad, file, 'kun/inv-viewer-02')

    for (const file of [
      'components/kun/KunInvariantExample.tsx',
      'proxy.ts',
      'constants/kunInvariantExample.ts',
      'server/viewer/fromHeaders.ts',
      'scripts/kunInvariantExample.ts'
    ]) {
      expect((await reportsAt(file)).length, file).toBeGreaterThan(0)
    }
    expect(await reportsAt('server/viewer/context.ts')).toEqual([])
  })

  // 读开关的只有引擎选择那一个文件; 测试靠 vi.mock 换掉整个模块, 不导入它, 所以不另外放行
  it('inv-search-01 全仓执法, 只放过 server/search/failure.ts', async () => {
    const inv = KUN_INVARIANTS.find((item) => item.id === 'inv-search-01')
    const [bad] = inv?.examples.bad ?? []
    const reportsAt = (file: string) =>
      reportsOf(eslint, bad, file, 'kun/inv-search-01')

    for (const file of [
      'app/api/galgame/service.ts',
      'app/api/search/route.ts',
      'server/galgame/search.ts',
      'server/search/query.ts',
      'scripts/kunInvariantExample.ts',
      'app/api/__tests__/kunInvariantExample.test.ts'
    ]) {
      expect((await reportsAt(file)).length, file).toBeGreaterThan(0)
    }
    expect(await reportsAt('server/search/failure.ts')).toEqual([])
  })

  // 新入口 (路由、别的 service、页面读取器、定时任务) 不能直接拿索引查询去用
  it('inv-search-02 只放过登记的四个调用方', async () => {
    const inv = KUN_INVARIANTS.find((item) => item.id === 'inv-search-02')
    const [bad] = inv?.examples.bad ?? []
    const reportsAt = (file: string) =>
      reportsOf(eslint, bad, file, 'kun/inv-search-02')

    for (const file of [
      'app/api/search/route.ts',
      'app/api/home/service.ts',
      'app/galgame/actions.ts',
      'server/galgame/cards.ts',
      'server/tasks/kunInvariantExample.ts'
    ]) {
      expect((await reportsAt(file)).length, file).toBeGreaterThan(0)
    }
    for (const file of [
      'server/galgame/search.ts',
      'app/api/galgame/service.ts',
      'app/api/tag/galgame/service.ts',
      'app/api/company/galgame/service.ts'
    ]) {
      expect(await reportsAt(file), file).toEqual([])
    }
  })

  // 解码入口只在 server/image; 业务目录 (路由、定时任务、脚本) 一律不许直接拿 sharp 去解码
  it('inv-image-01 只放过 server/image、instrumentation.ts 与测试', async () => {
    const reportsAt = (file: string) =>
      reportsOf(eslint, "import sharp from 'sharp'", file, 'kun/inv-image-01')

    for (const file of [
      'app/api/user/image/_upload.ts',
      'app/api/edit/_upload.ts',
      'server/tasks/moderationTask.ts',
      'server/storage/patchBanner.ts',
      'scripts/kunInvariantExample.ts'
    ]) {
      expect((await reportsAt(file)).length, file).toBeGreaterThan(0)
    }
    for (const file of [
      'server/image/pipeline.ts',
      'server/image/transcode.ts',
      'instrumentation.ts',
      'app/api/edit/__tests__/_upload.test.ts'
    ]) {
      expect(await reportsAt(file), file).toEqual([])
    }
  })

  // 这正是不用核心 no-restricted-* 承载不变量的原因: flat config 里后出现的同名规则
  // 带选项即整体替换。每条不变量各占一个 id 之后, 别人再怎么用核心规则都盖不到它
  it('后来的核心 no-restricted-* 块覆盖不了已登记的不变量', async () => {
    const withLaterBlocks = new ESLint({
      cwd: repoRoot,
      overrideConfig: [
        kunWithoutTypeInfo,
        {
          files: ['components/**'],
          rules: {
            'no-restricted-imports': [
              'error',
              { paths: [{ name: 'kun-unrelated-package' }] }
            ],
            'no-restricted-syntax': [
              'error',
              { selector: 'WithStatement', message: 'unrelated' }
            ]
          }
        }
      ]
    })
    const file = 'components/kun/KunInvariantExample.tsx'

    expect(
      await reportsOf(
        withLaterBlocks,
        "import { useRouter } from '@bprogress/next'",
        file,
        'kun/inv-bundle-02'
      )
    ).toHaveLength(1)
    expect(
      await reportsOf(
        withLaterBlocks,
        "import { z } from 'zod'",
        file,
        'kun/inv-bundle-01'
      )
    ).toHaveLength(1)
  })

  it('仓库内出现的每个 inv-* 都能在注册表里解析', () => {
    const known = new Set<string>(KUN_INVARIANTS.map((inv) => inv.id))
    const unknown = grepRepo('inv-').flatMap((line) =>
      (line.match(/\binv-[a-z]+-\d+\b/g) ?? [])
        .filter((id) => !known.has(id))
        .map((id) => `${id} ← ${line.slice(0, 120)}`)
    )
    expect(unknown).toEqual([])
  })

  // 任何配置块都不得把某条不变量关掉或降级, 哪怕只对一部分文件: 上面那条只查了
  // 示例文件所在的路径, 这条查的是组合后的每一个配置对象
  it('没有配置块把 kun/* 规则设为 error 以外的级别', () => {
    const downgraded = (
      eslintConfig as Array<{
        files?: unknown
        rules?: Record<string, unknown>
      }>
    ).flatMap((config) =>
      Object.entries(config.rules ?? {})
        .filter(([rule, value]) => {
          const severity = Array.isArray(value) ? value[0] : value
          return (
            rule.startsWith('kun/') && severity !== 'error' && severity !== 2
          )
        })
        .map(([rule, value]) => ({ rule, value, files: config.files }))
    )
    expect(downgraded).toEqual([])
  })

  // 行内指令 (eslint-disable* 与 /* eslint rule: off */) 提到 kun/inv-* 时, 原因必须
  // 与指令写在同一行
  it('每条针对 kun/inv-* 的行内 eslint 指令都带 -- 原因', () => {
    const withoutReason = grepRepo('kun/inv-').filter(
      (line) => /(\/\/|\/\*)\s*eslint\b/.test(line) && !/\s--\s+\S/.test(line)
    )
    expect(withoutReason).toEqual([])
  })
})

// 基线按「路径 + 规则 + 条数」记账。删掉文件后 lint 不会报残留的条目, 日后同路径的
// 新文件会白得这些额度; 所以删文件、改名之后必须跑 pnpm lint:prune
describe('lint 抑制基线', () => {
  it('基线里的每个路径都还存在', () => {
    const suppressions = JSON.parse(
      readFileSync(join(repoRoot, 'eslint-suppressions.json'), 'utf-8')
    ) as Record<string, unknown>
    const missing = Object.keys(suppressions).filter(
      (file) => !existsSync(join(repoRoot, file))
    )
    expect(missing).toEqual([])
  })
})

describe('kun 不变量规则工厂', { timeout: TIMEOUT }, () => {
  const probeId = 'inv-probe-01'
  const probeFile = 'utils/kunInvariantProbe.ts'
  const linterFor = (
    enforce: Parameters<typeof createKunInvariantRule>[0]['enforce']
  ) =>
    new ESLint({
      cwd: repoRoot,
      overrideConfig: [
        kunWithoutTypeInfo,
        {
          plugins: {
            kunProbe: {
              rules: {
                [probeId]: createKunInvariantRule({
                  id: probeId,
                  aliases: ['P1'],
                  statement: 'statement',
                  reason: 'reason',
                  removeWhen: 'never',
                  enforce,
                  examples: { file: probeFile, bad: [], good: [] }
                })
              }
            }
          },
          rules: { [`kunProbe/${probeId}`]: 'error' }
        }
      ]
    })
  const count = async (linter: ESLint, code: string) =>
    (await reportsOf(linter, code, probeFile, `kunProbe/${probeId}`)).length

  it('import 类按来源精确匹配, 支持正则与再导出, 不查动态 import', async () => {
    const linter = linterFor({
      kind: 'import',
      sources: ['exact-package', /^@scope\//]
    })

    expect(await count(linter, "import a from 'exact-package'")).toBe(1)
    expect(await count(linter, "import a from 'exact-package/sub'")).toBe(0)
    expect(await count(linter, "import { b } from '@scope/anything'")).toBe(1)
    expect(await count(linter, "export { b } from 'exact-package'")).toBe(1)
    expect(await count(linter, "export * from 'exact-package'")).toBe(1)
    expect(await count(linter, "import 'exact-package'")).toBe(1)
    expect(await count(linter, 'export const local = 1')).toBe(0)
    expect(
      await count(linter, "export const lazy = () => import('exact-package')")
    ).toBe(0)
  })

  it('allowTypeImports 放行整句 type 导入', async () => {
    const strict = linterFor({ kind: 'import', sources: ['exact-package'] })
    const lenient = linterFor({
      kind: 'import',
      sources: ['exact-package'],
      allowTypeImports: true
    })
    const typeImport = "import type { T } from 'exact-package'"

    expect(await count(strict, typeImport)).toBe(1)
    expect(await count(lenient, typeImport)).toBe(0)
    expect(await count(lenient, "import { v } from 'exact-package'")).toBe(1)
    // 全部成员都带 type 的行内写法同样被整句擦除; 混有值成员则不放行
    expect(
      await count(lenient, "import { type A, type B } from 'exact-package'")
    ).toBe(0)
    expect(
      await count(lenient, "import { type A, v } from 'exact-package'")
    ).toBe(1)
  })

  it('importNames 只拦指定成员', async () => {
    const linter = linterFor({
      kind: 'import',
      sources: ['exact-package'],
      importNames: ['banned', 'default']
    })

    expect(await count(linter, "import { banned } from 'exact-package'")).toBe(
      1
    )
    expect(
      await count(linter, "import { banned as ok } from 'exact-package'")
    ).toBe(1)
    expect(await count(linter, "import fallback from 'exact-package'")).toBe(1)
    expect(await count(linter, "import { allowed } from 'exact-package'")).toBe(
      0
    )
    expect(await count(linter, "import * as all from 'exact-package'")).toBe(0)
    // 字符串字面量成员名、以及会把被禁成员一并转出去的 export *
    expect(
      await count(linter, "import { 'banned' as ok } from 'exact-package'")
    ).toBe(1)
    expect(await count(linter, "export * from 'exact-package'")).toBe(1)
    expect(await count(linter, "export { allowed } from 'exact-package'")).toBe(
      0
    )
  })

  it('带 g 标志的正则来源不跨调用带状态', async () => {
    const linter = linterFor({ kind: 'import', sources: [/^stateful-/g] })
    const code = [1, 2, 3, 4]
      .map((n) => `import m${n} from 'stateful-package'`)
      .join('\n')

    expect(await count(linter, code)).toBe(4)
  })

  // 模板字符串按插值换成 $1 后的整串匹配: 被插值切开的一句 SQL 不会漏掉后半句
  it('syntax 类的 strings 匹配字符串字面量与整个模板字符串', async () => {
    const linter = linterFor({
      kind: 'syntax',
      selectors: [],
      strings: [/SET a = \$1, b\b/g]
    })

    expect(await count(linter, "export const q = 'SET a = $1, b = 2'")).toBe(1)
    expect(
      await count(
        linter,
        'export const q = (x: number) => `SET a = ${x}, b = 2`'
      )
    ).toBe(1)
    expect(
      await count(
        linter,
        'export const q = (x: number) => sql`SET a = ${x}, b = 2`'
      )
    ).toBe(1)
    expect(
      await count(linter, 'export const q = (x: number) => `SET a = ${x}`')
    ).toBe(0)
    // 带 g 标志的正则不跨节点带状态
    expect(
      await count(
        linter,
        "export const p = 'SET a = $1, b'\nexport const q = 'SET a = $1, b'"
      )
    ).toBe(2)
  })

  it('报错信息带 id、别名、理由与移除条件', async () => {
    const linter = linterFor({
      kind: 'syntax',
      selectors: ['DebuggerStatement']
    })
    const [report] = await reportsOf(
      linter,
      'debugger',
      probeFile,
      `kunProbe/${probeId}`
    )

    expect(report.message).toBe(
      'inv-probe-01（P1）：statement。理由：reason；移除条件：never'
    )
  })
})
