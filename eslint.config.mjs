import { fixupConfigRules } from '@eslint/compat'
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
import prettierRecommended from 'eslint-plugin-prettier/recommended'
import react from 'eslint-plugin-react'
import { kunInvariantConfigs } from './lint/kunInvariants.mjs'

const kunConfigs = defineConfig([
  globalIgnores([
    '.next/',
    // deployBuild.ts 的暂存构建 (构建失败会残留) 与回滚备份, 内含整份源码副本
    '.next-deploy/',
    '.next-previous/',
    // Agent 隔离运行的 worktree, 每个都是完整源码副本 (eslint 不读 .gitignore)
    '.claude/',
    // gitignore 的本地工作区, 内含 perf-audit 留下的压缩包产物 (单文件 450KB), 全量 lint 会跑 10 分钟以上;
    // tsconfig 与 vitest 已同样排除, CI 的 checkout 里没有这个目录
    'docs/',
    'node_modules/',
    'prisma/generated/'
  ]),
  // eslint-plugin-react / import / jsx-a11y 仍用 ESLint 10 已移除的旧 context API, 须经 fixup 桥接
  ...fixupConfigRules(nextCoreWebVitals),
  js.configs.recommended,
  ...fixupConfigRules([react.configs.flat.recommended]),
  ...fixupConfigRules(nextTypescript),
  prettierRecommended,
  {
    settings: {
      'import/ignore': ['node_modules'],
      react: {
        version: 'detect'
      }
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      // 格式选项以 .prettierrc.json 为单一事实源, eslint-plugin-prettier 会自行解析
      'prettier/prettier': 'error',
      'no-debugger': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'warn',
      // 注释里的零宽字符是保留词体系的示例, 模板串里的全角空格是中文报表缩进, 均非笔误
      'no-irregular-whitespace': [
        'error',
        { skipComments: true, skipTemplates: true }
      ],
      // ESLint 10 recommended 新增; 存量代码为「let 初始值 + 分支覆盖」风格, 维持升级前基线
      'no-useless-assignment': 'off',
      'sort-imports': 'off',
      // 338347dc 抽 service 后 route 层残留死导入至今无门禁 (8-20 #43)
      // 存量 26 条为本地 schema 只喂 z.infer 与组件未用 state, 清完后升 error
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true
        }
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@next/next/no-img-element': 'off',
      'react-hooks/exhaustive-deps': 'off',
      // eslint-plugin-react-hooks v7 新增的编译器规则, 对存量代码大面积报错, 维持升级前基线
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/incompatible-library': 'off',
      'react-hooks/immutability': 'off'
    }
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly'
      }
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  // 跨文件承重不变量 (C9 zod 命名空间导入、C19 bprogress 子路径等) 在 lint/kunInvariants.mjs
  // 逐条登记为 kun/inv-*。不要在本文件新增核心 no-restricted-imports / no-restricted-syntax
  // 块: 同名规则带选项即整体替换, 会静默关掉别处登记的禁令
  ...kunInvariantConfigs(),
  // 未使用的 eslint-disable 指令同样报 error: 这类报告没有 ruleId, 进不了抑制基线,
  // 出现就必须删掉
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    }
  }
])

// 闸门二值化 (T40): 每条规则只能是 error 或 off。warn 不阻塞 CI, 存量从 241 涨到 293
// 没有任何闸门察觉; 升为 error 后存量记入 eslint-suppressions.json 基线 (只减不增),
// 新增即红。逐个 config 对象改写即可: 后出现的 'off' 仍然覆盖前面被升上来的 error
const kunBinarizeSeverity = (configs) =>
  configs.map((config) => {
    if (!config.rules) {
      return config
    }
    const rules = Object.fromEntries(
      Object.entries(config.rules).map(([name, value]) => {
        const severity = Array.isArray(value) ? value[0] : value
        if (severity !== 'warn' && severity !== 1) {
          return [name, value]
        }
        return [
          name,
          Array.isArray(value) ? ['error', ...value.slice(1)] : 'error'
        ]
      })
    )
    return { ...config, rules }
  })

export default kunBinarizeSeverity(kunConfigs)
