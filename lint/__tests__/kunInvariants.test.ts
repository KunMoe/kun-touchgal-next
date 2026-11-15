import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { KUN_INVARIANTS, createKunInvariantRule } from '../kunInvariants.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const SELF = 'lint/__tests__/kunInvariants.test.ts'
// ESLint 首次加载整套配置与插件要数秒
const TIMEOUT = 60_000

const eslint = new ESLint({ cwd: repoRoot })

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

  // 这正是不用核心 no-restricted-* 承载不变量的原因: flat config 里后出现的同名规则
  // 带选项即整体替换。每条不变量各占一个 id 之后, 别人再怎么用核心规则都盖不到它
  it('后来的核心 no-restricted-* 块覆盖不了已登记的不变量', async () => {
    const withLaterBlocks = new ESLint({
      cwd: repoRoot,
      overrideConfig: [
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

  it('每条针对 kun/inv-* 的 eslint-disable 都带 -- 原因', () => {
    const withoutReason = grepRepo('kun/inv-').filter(
      (line) => /eslint-disable/.test(line) && !/\s--\s+\S/.test(line)
    )
    expect(withoutReason).toEqual([])
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
      'inv-probe-01 (P1): statement。理由: reason; 移除条件: never'
    )
  })
})
