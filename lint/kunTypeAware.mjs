// 类型感知 lint 子集 (T40 门控片 G1): 这两条规则要 TypeScript 的类型信息才判断得了,
// 仓库里其余规则都只看语法。
//
// 为什么留这两条: Prisma 的查询是惰性的 (PrismaPromise 不被 await / then / catch 就不会
// 发出), 漏写 await 的写入什么都不做, 而 mock 掉 prisma 的单测照样记到这次调用、照样通过;
// 取反的条件 `if (!异步检查())` 恒为假, tsc 自己不报 (TS2801 只管不取反的写法)。这两类只有
// 类型感知的 lint 看得见。对 Prisma 调用写 void 同样不会执行, 只能 await。
//
// 代价 (2026-11-27 实测, 1643 个文件, 本机): 全仓 lint 约 23 秒 → 38 秒 (建 program 约 5 秒,
// no-floating-promises 约 7 秒, no-misused-promises 约 3 秒), 内存峰值约 1.2 GB → 3.7 GB
// (堆上限 2 GB 能跑完, 1.5 GB 崩)。--concurrency 帮不上忙: 每个线程各建一份 program。
//
// 同一次实测里没有采用的三条 (新增类型感知规则之前先这样逐条测一遍命中):
// - await-thenable: 存量 5 条全是有意把同步值与 Promise 混进 Promise.all* 的数组, 规则没有
//   关掉这一项的选项
// - no-unnecessary-type-assertion: 51 条里没有真问题, 其中 3 条是规则把「在 X | undefined 上
//   补可选属性」的断言判成多余, --fix 删掉之后 tsc 报错 (lib/oidc/siteLogout.ts 等)
// - no-unsafe-return: 114 条里 98 条是测试的 mock 管道, 非测试的没有现成的故障路径
//
// 摘除: 删掉 eslint.config.mjs 里展开 kunTypeAwareConfigs() 的那一行, 再跑一次 pnpm lint:prune。
//
// 不直接依赖 typescript-eslint: 规则按名字引用 eslint-config-next/typescript 已经注册的
// 插件, 自己再注册一份会撞上 "Cannot redefine plugin"; 也不用 configs.*TypeChecked
// (一次带进几十条规则)。

/** @typedef {import('eslint').Linter.Config} KunLintConfig */

const TS_FILES = ['**/*.ts', '**/*.tsx']

/** @type {NonNullable<KunLintConfig['rules']>} */
const TYPE_AWARE_RULES = {
  // 没被 await、没接 .catch、也没写 void 的 Promise
  '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
  // 把 async 函数交给不等它的位置 (forEach(async …)、返回 void 的回调参数); 拿 Promise 当条件。
  // React 的事件属性 (onPress={async () => …}) 本来就不等返回值, attributes 不查
  '@typescript-eslint/no-misused-promises': [
    'error',
    { checksVoidReturn: { attributes: false } }
  ]
}

export const KUN_TYPE_AWARE_RULE_NAMES = Object.keys(TYPE_AWARE_RULES)

/**
 * @param {string} tsconfigRootDir tsconfig.json 所在目录 (仓库根)
 * @returns {KunLintConfig[]}
 */
export const kunTypeAwareConfigs = (tsconfigRootDir) => [
  {
    files: TS_FILES,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir }
    },
    rules: TYPE_AWARE_RULES
  }
]

// lintText 喂进来的路径不在磁盘上时 (lint/__tests__/kunInvariants.test.ts 的样例路径都是
// 虚构的), 类型服务找不到文件, 解析直接失败, 别的规则一条也跑不了。只测不用类型信息的
// 规则时把这一块追加在配置末尾
/** @type {KunLintConfig} */
export const kunWithoutTypeInfo = {
  files: TS_FILES,
  languageOptions: { parserOptions: { projectService: false } },
  rules: Object.fromEntries(
    KUN_TYPE_AWARE_RULE_NAMES.map((rule) => [rule, 'off'])
  )
}
