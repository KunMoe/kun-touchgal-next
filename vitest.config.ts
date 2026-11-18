import { fileURLToPath } from 'url'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '~': fileURLToPath(new URL('./', import.meta.url)),
      // server-only 的默认入口一导入就 throw, 只有 Next 打包时的 react-server 条件才解析到
      // 空模块; 测试直接加载这些模块, 所以指到同一个空模块
      'server-only': fileURLToPath(
        new URL(
          './node_modules/next/dist/compiled/server-only/empty.js',
          import.meta.url
        )
      )
    }
  },
  test: {
    include: ['**/__tests__/**/*.test.ts'],
    // 构建目录 (standalone 会复制整份项目) 与 Agent worktree 都藏着 __tests__ 副本,
    // 陈旧副本会 FAIL; docs/ 是 gitignore 的本地工作区, 其中的计时脚本会超时;
    // 显式 exclude 会整体覆盖 Vitest 默认值 (含 node_modules), 故必须展开 configDefaults
    exclude: [
      ...configDefaults.exclude,
      '.next/**',
      '.next-deploy/**',
      '.next-previous/**',
      '.claude/**',
      'docs/**'
    ]
  }
})
