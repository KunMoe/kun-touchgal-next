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
    // 单测连不上任何真 Redis: lib/redis.ts 在加载时读这两个变量, 这里的值盖过 shell 里导出的,
    // prisma/index.ts 的 dotenv/config 又不覆盖已有的值, 所以与导入顺序无关。不这样做的话,
    // 环境里带着 REDIS_* 或 dotenv 先于 lib/redis 加载时, 没 mock 的用例会把缓存键写进那个
    // Redis (开发库)。真 Redis 的契约用例由 lib/__tests__/redisContract.ts 在导入之前改写
    env: { REDIS_HOST: '127.0.0.1', REDIS_PORT: '0' },
    // 构建目录 (standalone 会复制整份项目) 与 Agent worktree 都藏着 __tests__ 副本,
    // 陈旧副本会 FAIL; docs/ 是 gitignore 的本地工作区, 其中的计时脚本会超时;
    // migration/backup/ 是 gitignore 的本地归档 (移出仓库的一次性脚本连同测试), 不再维护;
    // 显式 exclude 会整体覆盖 Vitest 默认值 (含 node_modules), 故必须展开 configDefaults
    exclude: [
      ...configDefaults.exclude,
      '.next/**',
      '.next-deploy/**',
      '.next-previous/**',
      '.claude/**',
      'docs/**',
      'migration/backup/**'
    ]
  }
})
