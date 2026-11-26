import { kunRoute } from '~/app/api/utils/kunRoute'

// 运行期读环境变量: 不声明的话 next build 会把这个 GET 预渲染成静态文件, 发布 id 冻结在构建那一刻
export const dynamic = 'force-dynamic'

// 部署闸门 (scripts/release/activate.ts) 与金丝雀 (scripts/release/smoke.ts) 用它确认进程跑的是哪个发布:
// KUN_RELEASE_ID 由发布组装写进发布自己的 .env (scripts/release/assemble.ts), 旧布局的构建没有它, 回 null。
// 这里不碰库与 Redis: 闸门只认进程起来了没有、是不是这个发布; 依赖检查等 T76 加在这个文件里
export const GET = kunRoute.get({
  auth: 'public',
  handler: () => ({ release: process.env.KUN_RELEASE_ID ?? null })
})
