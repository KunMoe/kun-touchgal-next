import { fixupConfigRules } from '@eslint/compat'
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'
import prettierRecommended from 'eslint-plugin-prettier/recommended'
import react from 'eslint-plugin-react'

export default defineConfig([
  // migration/backup 是已执行完毕的一次性脚本归档 (多带 @ts-nocheck), 不再维护
  globalIgnores([
    '.next/',
    // deployBuild.ts 的暂存构建 (构建失败会残留) 与回滚备份, 内含整份源码副本
    '.next-deploy/',
    '.next-previous/',
    // Agent 隔离运行的 worktree, 每个都是完整源码副本 (eslint 不读 .gitignore)
    '.claude/',
    'node_modules/',
    'prisma/generated/',
    'migration/backup/'
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
      // 338347dc 抽 service 后 route 层残留死导入至今无门禁 (8-20 #43); 存量 26 条为本地 schema 只喂 z.infer 与组件未用 state, 清完后升 error
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
  }
])
