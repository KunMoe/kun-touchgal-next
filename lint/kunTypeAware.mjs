// 类型感知 lint 子集 (T40 门控片 G1): 这里的规则要 TypeScript 的类型信息才判断得了,
// 仓库里其余规则都只看语法。
//
// 为什么留这几条: Prisma 的查询是惰性的 (PrismaPromise 不被 await / then / catch / finally,
// 也没交给 $transaction([...]), 就不会发出), 漏写 await 的写入什么都不做, 而 mock 掉 prisma 的
// 单测照样记到这次调用、照样通过; 取反的条件 `if (!异步检查())` 恒为假, tsc 自己不报
// (TS2801 只管不取反的写法)。这两类只有类型感知的 lint 看得见。
//
// 代价 (2026-11-27 实测, 1643 个文件, 本机 16 GB): 全仓 lint 约 23 秒 → 38 秒 (建 program
// 约 5 秒, no-floating-promises 约 7 秒, no-misused-promises 约 3 秒), 内存峰值约 1.2 GB →
// 3.7 GB。堆上限 2 GB 能跑完 (慢), 1.5 GB 崩; Node 的默认上限随物理内存缩小, 内存不到 16 GB 的
// 机器要加 NODE_OPTIONS=--max-old-space-size=3072 (按默认算法推算, 没在小内存机器上实测)。
// --concurrency 帮不上忙: 每个线程各建一份 program。
//
// 同一次实测里没有采用的三条 (新增类型感知规则之前先这样逐条测一遍命中):
// - await-thenable: 存量 5 条全是有意把同步值与 Promise 混在一起 await (4 条是交给
//   Promise.all* 的数组, 1 条是测试里逐个 await 同步与异步混排的步骤), 规则没有选项可调
// - no-unnecessary-type-assertion: 51 条里没有真问题, 而它把「在 X | undefined 上补可选属性」
//   的断言判成多余, 全仓 --fix 之后 tsc 报 13 处错 (lib/oidc/siteLogout.ts 等 8 个文件)
// - no-unsafe-return: 114 条里 98 条在测试文件里, 非测试的没有现成的故障路径
//
// 摘除: 删掉 eslint.config.mjs 里的 import 与展开 kunTypeAwareConfigs() 的那一行, 删掉
// lint/__tests__/kunTypeAware.test.ts, 再跑一次 pnpm lint:prune。本文件留着:
// kunInvariants.test.ts 还从这里导入 kunWithoutTypeInfo。
//
// 不直接依赖 typescript-eslint: 规则按名字引用 eslint-config-next/typescript 已经注册的
// 插件, 自己再注册一份会撞上 "Cannot redefine plugin"; 也不用 configs.*TypeChecked
// (一次带进几十条规则)。
//
// 类型服务只认 tsconfig.json 收进来的文件: TS 的 ** 不进点目录, 放在点目录里的 .ts
// (如 app/.well-known/…) 要先写进 tsconfig 的 include, 否则 lint 报 "was not found by the
// project service"。

/** @typedef {import('eslint').Linter.Config} KunLintConfig */

const TS_FILES = ['**/*.ts', '**/*.tsx']

// no-floating-promises 的报文与 IDE 的第一个快速修复都是「加 void」, 而 void 不会去碰
// then / catch / finally: `void prisma.x.update(…)` 永远不执行。这条规则把这个出口堵上。
// 认的是类型上的 [Symbol.toStringTag]: 'PrismaPromise' (PrismaPromise 与各 model 的
// Prisma__xxxClient 都带, 与运行时对象上的标记是同一个); 接了 .catch(…) 之后是普通 Promise, 不报
/** @type {import('eslint').Rule.RuleModule} */
const kunNoVoidPrisma = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      lazy: 'Prisma 的查询是惰性的, 只写 void 不会执行。要结果就 await; 不等结果就接 .catch(…) (事务里只能 await, 否则可能在提交之后才发出)'
    }
  },
  create(context) {
    const services = context.sourceCode.parserServices
    if (!services?.program) {
      throw new Error(
        'kun-typed/no-void-prisma 需要类型信息 (parserOptions.projectService)'
      )
    }
    const checker = services.program.getTypeChecker()
    const isPrismaPromise = (type) =>
      type.isUnion()
        ? type.types.some(isPrismaPromise)
        : checker.getPropertiesOfType(type).some((property) => {
            if (!property.getName().startsWith('__@toStringTag')) {
              return false
            }
            const tag = checker.getTypeOfSymbol(property)
            return tag.isStringLiteral() && tag.value === 'PrismaPromise'
          })
    return {
      "UnaryExpression[operator='void']"(node) {
        if (isPrismaPromise(services.getTypeAtLocation(node.argument))) {
          context.report({ node, messageId: 'lazy' })
        }
      }
    }
  }
}

/** @type {NonNullable<KunLintConfig['rules']>} */
const TYPE_AWARE_RULES = {
  // 没被 await、没接 .catch、也没写 void 的 Promise
  '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
  // 把 async 函数交给不等它的位置 (forEach(async …)、返回 void 的回调参数); 拿 Promise 当条件。
  // attributes: false 是所有 JSX 属性都不查, 不只是 onPress 这类事件属性, 自定义组件的回调 prop
  // (onSuccess、onImageComplete …) 也在内: 实测 125 处, 其中 96 处是 onPress, 没有按属性名
  // 豁免的选项
  '@typescript-eslint/no-misused-promises': [
    'error',
    { checksVoidReturn: { attributes: false } }
  ],
  'kun-typed/no-void-prisma': 'error'
}

export const KUN_TYPE_AWARE_RULE_NAMES = Object.keys(TYPE_AWARE_RULES)

/**
 * @param {string} tsconfigRootDir tsconfig.json 所在目录 (仓库根)
 * @returns {KunLintConfig[]}
 */
export const kunTypeAwareConfigs = (tsconfigRootDir) => [
  {
    files: TS_FILES,
    plugins: {
      'kun-typed': {
        meta: { name: 'kun-typed' },
        rules: { 'no-void-prisma': kunNoVoidPrisma }
      }
    },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir }
    },
    rules: TYPE_AWARE_RULES
  }
]

// lintText 喂进来的路径不在磁盘上时 (lint/__tests__/kunInvariants.test.ts 的样例路径多数是
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
