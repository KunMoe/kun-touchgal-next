// 跨文件承重不变量的注册表 (T40): 一条不变量一个规则 id。
//
// 为什么不写成 eslint.config.mjs 里的核心 no-restricted-imports / no-restricted-syntax:
// flat config 合并 rules 时, 后出现的同名规则只要带选项就整体替换前者。任何一个后来的
// 配置块再用一次这两条核心规则, 之前登记的禁令就在它的作用域内静默失效, CI 照样全绿。
// 每条不变量各占一个 kun/inv-* id 之后, 新规则只能新增 id, 覆盖不到别人。
//
// 登记门槛: 必须有能报错的 bad 样例 (lint/__tests__/kunInvariants.test.ts 逐条执行)。
// 这里只收由机器执行的代码约束, 不收生产状态和审查流程。

/**
 * @typedef {{
 *   id: `inv-${string}`,
 *   aliases?: string[],
 *   statement: string,
 *   reason: string,
 *   removeWhen: string,
 *   files?: string[],
 *   ignores?: string[],
 *   enforce:
 *     | { kind: 'import', sources: (string | RegExp)[], importNames?: string[], allowTypeImports?: boolean }
 *     | { kind: 'syntax', selectors: string[] },
 *   examples: { file: string, bad: string[], good: string[] }
 * }} KunInvariant
 */

/** @type {KunInvariant[]} */
export const KUN_INVARIANTS = [
  {
    id: 'inv-bundle-01',
    aliases: ['C9'],
    statement: "zod 必须用命名空间导入: import * as z from 'zod'",
    reason:
      'zod 根入口的 z 是整个命名空间再导出, Turbopack 无法按成员裁剪, 具名/默认导入会打进全量 zod (含 62 个语言包, 约 90KB gz); 命名空间导入实测 32KB',
    removeWhen: 'bundler 能按成员裁剪 zod 根入口的 z 再导出',
    // 用选择器而不是 import 类的 importNames: 后者会连 import * as z 一起拦
    enforce: {
      kind: 'syntax',
      selectors: [
        "ImportDeclaration[source.value='zod'][importKind!='type'] > :matches(ImportSpecifier[imported.name='z'][importKind!='type'], ImportDefaultSpecifier)"
      ]
    },
    examples: {
      file: 'validations/kunInvariantExample.ts',
      bad: ["import { z } from 'zod'", "import z from 'zod'"],
      good: ["import * as z from 'zod'", "import type { z } from 'zod'"]
    }
  },
  {
    id: 'inv-bundle-02',
    aliases: ['C19'],
    statement: "只许从 '@bprogress/next/app' 子路径导入, 不得导入根入口",
    reason:
      '根入口顶层 import next/router 并给 PagesProgress 赋 displayName, 补 sideEffects:false 也裁不掉, 整套 Pages Router (46 模块, 约 23KB gz) 会进全站 layout 块; 子路径的前 273 行与根入口逐字相同, useRouter 是同一个函数',
    removeWhen: '@bprogress/next 根入口不再顶层引用 next/router',
    enforce: { kind: 'import', sources: ['@bprogress/next'] },
    examples: {
      file: 'components/kun/KunInvariantExample.tsx',
      bad: ["import { useRouter } from '@bprogress/next'"],
      good: ["import { useRouter } from '@bprogress/next/app'"]
    }
  },
  {
    id: 'inv-store-01',
    statement: 'zustand 的 use*Store() 必须带 selector',
    reason: '不带 selector 会订阅整个 store, 任一字段变化都让调用组件重渲染',
    removeWhen: '全仓不再使用 zustand',
    enforce: {
      kind: 'syntax',
      selectors: [
        'CallExpression[callee.name=/^use[A-Z]\\w*Store$/][arguments.length=0]'
      ]
    },
    examples: {
      file: 'components/kun/KunInvariantExample.tsx',
      bad: ['const state = useUserStore()'],
      good: ['const uid = useUserStore((state) => state.user.uid)']
    }
  }
]

const formatMessage = (/** @type {KunInvariant} */ inv) =>
  `${inv.id}${inv.aliases?.length ? ` (${inv.aliases.join(', ')})` : ''}: ${inv.statement}。理由: ${inv.reason}; 移除条件: ${inv.removeWhen}`

const importedName = (specifier) =>
  specifier.type === 'ImportDefaultSpecifier'
    ? 'default'
    : specifier.type === 'ImportNamespaceSpecifier'
      ? '*'
      : (specifier.imported ?? specifier.local)?.name

// 只用 context.report 与 selector 两个稳定 API。import 类与核心 no-restricted-imports
// 一样不检查 ImportExpression, 所以「只许经 import() 懒加载」可以直接表达
/** @type {(inv: KunInvariant) => import('eslint').Rule.RuleModule} */
export const createKunInvariantRule = (inv) => ({
  meta: { type: 'problem', schema: [] },
  create(context) {
    const message = formatMessage(inv)
    const report = (node) => context.report({ node, message })
    const { enforce } = inv
    if (enforce.kind === 'syntax') {
      return Object.fromEntries(
        enforce.selectors.map((selector) => [selector, report])
      )
    }

    const check = (node) => {
      const source = node.source?.value
      const matched = enforce.sources.some((candidate) =>
        typeof candidate === 'string'
          ? candidate === source
          : candidate.test(source)
      )
      if (!matched) {
        return
      }
      const isTypeOnly = (node.importKind ?? node.exportKind) === 'type'
      if (enforce.allowTypeImports && isTypeOnly) {
        return
      }
      if (
        enforce.importNames &&
        !(node.specifiers ?? []).some((specifier) =>
          enforce.importNames.includes(importedName(specifier))
        )
      ) {
        return
      }
      report(node)
    }
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: (node) => node.source && check(node),
      ExportAllDeclaration: check
    }
  }
})

export const kunInvariantPlugin = {
  meta: { name: 'kun' },
  rules: Object.fromEntries(
    KUN_INVARIANTS.map((inv) => [inv.id, createKunInvariantRule(inv)])
  )
}

export const kunInvariantConfigs = () =>
  KUN_INVARIANTS.map((inv) => ({
    ...(inv.files ? { files: inv.files } : {}),
    ...(inv.ignores ? { ignores: inv.ignores } : {}),
    plugins: { kun: kunInvariantPlugin },
    rules: { [`kun/${inv.id}`]: 'error' }
  }))
