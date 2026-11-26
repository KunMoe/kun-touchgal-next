import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import eslintConfig from '../../eslint.config.mjs'
import { KUN_TYPE_AWARE_RULE_NAMES } from '../kunTypeAware.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
// 类型服务只认磁盘上、且在 tsconfig 里的文件: 拿本文件自己的路径当样例的落点, 它不会过期
const SELF = relative(repoRoot, fileURLToPath(import.meta.url))
// 第一次 lintText 要给整个仓库建 TypeScript program
const TIMEOUT = 120_000

const FLOATING = '@typescript-eslint/no-floating-promises'
const MISUSED = '@typescript-eslint/no-misused-promises'
const VOID_PRISMA = 'kun-typed/no-void-prisma'

const eslint = new ESLint({ cwd: repoRoot })

const rulesReported = async (code: string) => {
  const [result] = await eslint.lintText(`${code}\n`, { filePath: SELF })
  expect(
    result.messages.filter((message) => message.fatal),
    '样例应能解析'
  ).toEqual([])
  return result.messages
    .map((message) => message.ruleId)
    .filter((ruleId) => KUN_TYPE_AWARE_RULE_NAMES.includes(ruleId ?? ''))
}

describe('类型感知 lint 子集', { timeout: TIMEOUT }, () => {
  it('登记的就是这三条规则', () => {
    expect(KUN_TYPE_AWARE_RULE_NAMES).toEqual([FLOATING, MISUSED, VOID_PRISMA])
  })

  // 连选项一起钉死: 放宽选项 (ignoreIIFE、checksVoidReturn 的其它开关、放行名单) 与关掉
  // 规则一样会让它不再报, 改选项就得来改这里
  it.each([
    'server/db/tx.ts',
    'components/kun/Rating.tsx',
    'server/db/__tests__/tx.test.ts',
    'scripts/postbuild.ts'
  ])('%s 上三条规则都是 error、选项没被放宽, 且带类型信息', async (file) => {
    const config = await eslint.calculateConfigForFile(file)
    expect(config.rules[FLOATING]).toEqual([2, { ignoreVoid: true }])
    expect(config.rules[MISUSED]).toEqual([
      2,
      { checksVoidReturn: { attributes: false } }
    ])
    expect(config.rules[VOID_PRISMA]).toEqual([2])
    expect(config.languageOptions.parserOptions.projectService).toBe(true)
  })

  // 上面只查了几个路径; 这条查组合后的每一个配置对象, 对一部分文件关掉或降级也算
  it('没有配置块把这三条规则设为 error 以外的级别', () => {
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
            KUN_TYPE_AWARE_RULE_NAMES.includes(rule) &&
            severity !== 'error' &&
            severity !== 2
          )
        })
        .map(([rule, value]) => ({ rule, value, files: config.files }))
    )
    expect(downgraded).toEqual([])
  })

  // 这些规则在没有类型信息的文件上一运行就抛错, 不能漏到 TypeScript 之外
  it('不是 TypeScript 的文件不挂这些规则', async () => {
    const config = await eslint.calculateConfigForFile('eslint.config.mjs')
    for (const rule of KUN_TYPE_AWARE_RULE_NAMES) {
      expect(config.rules[rule]?.[0] ?? 0, rule).toBe(0)
    }
  })

  // 行内指令是配置之外的另一个出口: 整段 / 整文件的 eslint-disable 一律不许,
  // 逐行的必须把原因写在同一行。无命中时 git grep 以 1 退出
  it('针对这三条规则的行内 eslint 指令只许逐行、且带 -- 原因', () => {
    const lines = KUN_TYPE_AWARE_RULE_NAMES.flatMap((rule) => {
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
            rule,
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
    })
    const directives = lines.filter((line) =>
      /(\/\/|\/\*)\s*eslint(-disable|-enable|\s)/.test(line)
    )
    expect(
      directives.filter(
        (line) =>
          !/eslint-disable-(next-line|line)\b/.test(line) ||
          !/\s--\s+\S/.test(line)
      )
    ).toEqual([])
  })

  // 规则「开着」不等于「还报得出」: 它默认只认声明成内建 Promise 的值 (checkThenables 关着),
  // PrismaPromise 现在是 extends Promise。升级 prisma / typescript-eslint / ioredis 之后声明
  // 一变, 规则就一声不吭, tsc 照样通过。Prisma 的查询是惰性的, 漏写 await 的写入根本不执行,
  // 而 mock 掉 prisma 的单测照样通过, 所以这里拿仓库里真实的类型把每种形状各报一次
  it.each([
    [
      '直接调用 prisma 漏写 await',
      `import { prisma } from '~/prisma'
export const f = async (uid: number) => {
  prisma.user.update({ where: { id: uid }, data: { bio: 'x' } })
}`
    ],
    [
      'kunTx 回调里的 tx 漏写 await',
      `import { kunTx } from '~/server/db/tx'
export const f = (uid: number) =>
  kunTx('probe.case', async (ctx) => {
    ctx.tx.user.update({ where: { id: uid }, data: { bio: 'x' } })
    return 1
  })`
    ],
    [
      '收 KunTx 的 helper 里漏写 await',
      `import type { KunTx } from '~/prisma'
export const f = async (tx: KunTx, uid: number) => {
  tx.user.update({ where: { id: uid }, data: { bio: 'x' } })
}`
    ],
    [
      'redis 调用漏写 await',
      `import { redis } from '~/lib/redis'
export const f = async (key: string) => {
  redis.del(key)
}`
    ]
  ])('%s → no-floating-promises', async (_name, code) => {
    expect(await rulesReported(code)).toEqual([FLOATING])
  })

  it.each([
    [
      'forEach 里传 async 回调 (没人等它)',
      `export const f = (ids: number[], g: (id: number) => Promise<void>) => {
  ids.forEach(async (id) => {
    await g(id)
  })
}`
    ],
    // 守卫永远不拦: !Promise 恒为假。tsc 的 TS2801 只报不取反的写法
    [
      '对返回 Promise 的检查取反当条件',
      `export const f = async (allowed: () => Promise<boolean>) => {
  if (!allowed()) {
    return '无权操作'
  }
  return 1
}`
    ]
  ])('%s → no-misused-promises', async (_name, code) => {
    expect(await rulesReported(code)).toEqual([MISUSED])
  })

  // no-floating-promises 的报文与 IDE 的第一个快速修复都是「加 void」; 对惰性的 Prisma 查询,
  // 那等于把「漏写 await」换成另一种永远不执行的写法
  it.each([
    [
      'void 直接作用在 model 查询上',
      `import { prisma } from '~/prisma'
export const f = (uid: number) => {
  void prisma.user.update({ where: { id: uid }, data: { bio: 'x' } })
}`
    ],
    [
      'void 直接作用在事务里的原生 SQL 上',
      `import type { KunTx } from '~/prisma'
export const f = (tx: KunTx) => {
  void tx.$executeRaw\`SELECT 1\`
}`
    ]
  ])('%s → no-void-prisma', async (_name, code) => {
    expect(await rulesReported(code)).toEqual([VOID_PRISMA])
  })

  it('写了 await、接了 .catch 的 Prisma 调用, 与 void 掉的普通 Promise 都不报', async () => {
    expect(
      await rulesReported(`import { prisma } from '~/prisma'
import { redis } from '~/lib/redis'
export const f = async (uid: number, key: string) => {
  await prisma.user.update({ where: { id: uid }, data: { bio: 'x' } })
  void prisma.user.count().catch(() => 0)
  void redis.del(key)
}`)
    ).toEqual([])
  })
})
