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
    statement:
      'zustand 的 use*Store() 必须带 selector, 且不能是返回整个 state 的恒等 selector',
    reason:
      '不带 selector 或写成 (state) => state 都会订阅整个 store, 任一字段变化都让调用组件重渲染',
    removeWhen: '全仓不再使用 zustand',
    enforce: {
      kind: 'syntax',
      selectors: [
        'CallExpression[callee.name=/^use[A-Z]\\w*Store$/][arguments.length=0]',
        // 函数体是裸标识符的箭头函数: 要么原样返回参数, 要么返回与 store 无关的外部变量
        "CallExpression[callee.name=/^use[A-Z]\\w*Store$/] > ArrowFunctionExpression[body.type='Identifier']"
      ]
    },
    examples: {
      file: 'components/kun/KunInvariantExample.tsx',
      bad: [
        'const state = useUserStore()',
        'const state = useUserStore((state) => state)'
      ],
      good: [
        'const uid = useUserStore((state) => state.user.uid)',
        'const [uid, name] = useUserStore(useShallow((state) => [state.user.uid, state.user.name]))'
      ]
    }
  },
  {
    id: 'inv-content-01',
    statement:
      'html-to-text 只许在 server/content/text.ts 里导入, 其余一律用 kunHtmlToText',
    reason:
      '各处自配 convert 选项会让同一段 HTML 得到不同的文本 (描述与 og 曾因此不一致); 对 markdown 原文跑 HTML 转换器还会把 <…> 当标签吞掉',
    removeWhen: '全仓不再需要 HTML → 纯文本投影',
    ignores: ['server/content/text.ts'],
    enforce: { kind: 'import', sources: ['html-to-text'] },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: ["import { convert } from 'html-to-text'"],
      good: ["import { kunHtmlToText } from '~/server/content/text'"]
    }
  },
  {
    id: 'inv-content-02',
    statement:
      '服务端与 metadata 不得用 markdownToText 取文本, 改从已净化 HTML 经 kunHtmlToText 派生',
    reason:
      'markdownToText 是按正则近似的客户端工具, 不认识指令与内嵌 HTML, 输出与读者实际看到的渲染结果不一致',
    removeWhen: 'utils/markdownToText 被删除',
    files: ['app/api/**', 'server/**', 'app/**/metadata.ts'],
    enforce: {
      kind: 'import',
      sources: [/(^|\/)utils\/markdownToText(\.tsx?)?$/]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "import { markdownToText } from '~/utils/markdownToText'",
        "import { markdownToText } from '~/utils/markdownToText.tsx'"
      ],
      good: ["import { kunHtmlToText } from '~/server/content/text'"]
    }
  },
  {
    id: 'inv-content-03',
    statement: '`as KunSafeHtml` 只许出现在登记的生产者文件里',
    reason:
      '品牌只存在于编译期, 随手断言等于把没渲染过的字符串放行到 HTML 汇点与文本投影',
    removeWhen: 'KunSafeHtml 品牌被移除',
    // 生产者: 服务端 markdown 渲染的唯一入口、落库 HTML 读取器、编辑器预览器,
    // 以及两处客户端净化 / 高亮 (DOMPurify、sugar-high)
    ignores: [
      'app/api/utils/render/renderKunMarkdown.ts',
      'app/api/patch/comment/html.ts',
      'utils/markdownPreview.ts',
      'components/patch/resource/kun/KunResourceDownload.tsx',
      'lib/mdx/element/KunCode.tsx'
    ],
    enforce: {
      kind: 'syntax',
      selectors: [
        "TSAsExpression > TSTypeReference[typeName.name='KunSafeHtml']",
        "TSTypeAssertion > TSTypeReference[typeName.name='KunSafeHtml']"
      ]
    },
    examples: {
      file: 'app/api/kunInvariantExample.ts',
      bad: [
        "export const html = '<p>x</p>' as KunSafeHtml",
        'export const cast = (raw: string) => raw as unknown as KunSafeHtml'
      ],
      good: [
        'export const size = (html: KunSafeHtml) => html.length',
        'export const load = async (): Promise<KunSafeHtml> => render()'
      ]
    }
  },
  {
    id: 'inv-content-04',
    statement: 'dangerouslySetInnerHTML 的值必须是 kunInnerHtml(...) 调用',
    reason:
      '__html 的类型在结构上什么都收; 只有 kunInnerHtml 的入参把来源收窄到 KunSafeHtml',
    removeWhen: '全仓不再使用 dangerouslySetInnerHTML',
    enforce: {
      kind: 'syntax',
      selectors: [
        "JSXAttribute[name.name='dangerouslySetInnerHTML'] > JSXExpressionContainer > :not(CallExpression[callee.name='kunInnerHtml'])"
      ]
    },
    examples: {
      file: 'components/kun/KunInvariantExample.tsx',
      bad: [
        'export const A = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />'
      ],
      good: [
        'export const A = ({ html }: { html: KunSafeHtml }) => <div dangerouslySetInnerHTML={kunInnerHtml(html)} />'
      ]
    }
  }
]

const formatMessage = (/** @type {KunInvariant} */ inv) =>
  `${inv.id}${inv.aliases?.length ? `（${inv.aliases.join('、')}）` : ''}：${inv.statement}。理由：${inv.reason}；移除条件：${inv.removeWhen}`

// 成员名可以是标识符, 也可以是字符串字面量 (import { 'a-b' as x })
const nameOf = (node) => node?.name ?? node?.value

const importedName = (specifier) =>
  specifier.type === 'ImportDefaultSpecifier'
    ? 'default'
    : specifier.type === 'ImportNamespaceSpecifier'
      ? '*'
      : nameOf(specifier.imported ?? specifier.local)

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
          : // search 不读写 lastIndex, 带 g / y 标志的正则也不会跨调用带状态
            typeof source === 'string' && source.search(candidate) !== -1
      )
      if (!matched) {
        return
      }
      const specifiers = node.specifiers ?? []
      // 整句 `import type` 与全部成员都带 type 的行内写法都会被编译器整句擦除
      const isTypeOnly =
        (node.importKind ?? node.exportKind) === 'type' ||
        (specifiers.length > 0 &&
          specifiers.every(
            (specifier) =>
              (specifier.importKind ?? specifier.exportKind) === 'type'
          ))
      if (enforce.allowTypeImports && isTypeOnly) {
        return
      }
      // 只禁部分成员时: `export * from` 会把被禁成员一并转出去, 照报;
      // `import * as ns` 不报 —— 命名空间导入正是 C9 要求的写法
      if (
        enforce.importNames &&
        node.type !== 'ExportAllDeclaration' &&
        !specifiers.some((specifier) =>
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
