# Repository Guidelines

## Project Overview

TouchGal (`kun-touchgal-next`) 是一个基于 Next.js 16 App Router 的 Galgame 文化社区站点，提供作品/补丁资料、资源下载、评分评论、用户主页、私信、后台管理、OIDC 和 MDX 内容页。

主栈为 React 19、TypeScript strict、HeroUI、Tailwind CSS v4、PostgreSQL + Prisma 7、Redis 和 S3 兼容对象存储；Meilisearch 为可选搜索后端，未启用或异常时回退到 Prisma。

## Architecture & Data Flow

- `app/**/page.tsx` 默认是 Server Component。列表/详情页通常调用同目录 `actions.ts`，由 Server Action 复用 `app/api/**/service.ts`，再访问 Prisma、Redis 或 Meilisearch；需要交互时将 `initial*` 数据传给 Client Component。
- 浏览器交互路径为 Client Component → `utils/kunFetch.ts` → `app/api/**/route.ts` → `app/api/utils/parseQuery.ts` + `validations/*.ts` → JWT/角色/所有权校验 → service → Prisma/缓存。不要在组件内重复实现内部 fetch 包装。
- Route Handler 保持薄：解析、鉴权、分派和 `NextResponse.json`；查询、事务和 DTO 转换放同目录 `service.ts`、HTTP 动词文件或共享 helper。
- PostgreSQL 统一通过 `prisma/index.ts` 的单例访问。多表变更与审计日志使用 `prisma.$transaction`；可复用 helper 接收 transaction client。提交后再失效 Redis、刷新用户会话或排队同步搜索。
- Redis key 经 `lib/redis.ts` 统一加 `kun:touchgal` 前缀。共享内容缓存必须包含可见性条件；管理员、作者或待审核内容需要按现有逻辑绕过共享缓存。
- S3 上传先进入临时 key，校验对象后复制到最终位置。数据库事务提交后再执行对象复制/删除等外部副作用，参考 `app/api/patch/resource/_helper.ts`。
- `proxy.ts`（Next 16 前身为 `middleware.ts`）为写 API 执行 CSRF 检查并保护 `/admin`、`/user`、`/edit` 等页面；上传 API 因请求体限制在 handler 内自行校验。认证 cookie 为 `kun-galgame-patch-moe-token`。
- `instrumentation.ts` 仅在 Node runtime 且 `KUN_ENABLE_CRON=true` 时加载 `server/cron.ts`。生产由 PM2 分离普通 Web worker 与单个 cron worker；任务使用 Redis 锁避免重复执行。

## Key Directories

- `app/`：App Router 页面、布局、Server Actions、Route Handlers、错误/元数据边界及 OIDC 路由。
- `app/api/`：HTTP 边界和主要领域服务；复杂查询或写入不要堆在 `route.ts`。
- `components/`：按 `patch`、`resource`、`search`、`user`、`admin` 等领域组织的 UI；`components/kun/` 为共享组件。
- `store/`：Zustand 状态；持久状态使用 `persist`，简单表单状态留在组件内。
- `validations/`：API 与 Server Action 共用的 Zod schema，包含中文用户错误信息。
- `prisma/schema/`：拆分的 PostgreSQL schema；生成 client 位于 `prisma/generated/prisma/`。
- `lib/`：Redis、S3、Meilisearch、OIDC、MDX 和第三方集成。
- `server/`：cron 编排、定时任务、审核流水线和搜索索引同步。
- `middleware/`：JWT、cookie 与 CSRF 实现。
- `utils/`：fetch、错误处理、cookie、Markdown、URL/文件名安全处理及 Server Action helper。
- `constants/`、`types/`、`config/`：领域常量/Prisma select、API DTO 和运行时配置。
- `scripts/`：构建后复制、sitemap、搜索、部署、OIDC 和数据回填脚本。
- `migration/`：人工执行的一次性迁移；`migration/backup/` 含历史及破坏性脚本，不得当作常规工作流运行。
- `posts/`、`public/`：运行时 MDX 内容和静态资源；两者参与 standalone 构建复制或 sitemap 生成。

## Development Commands

先复制 `.env.example` 为 `.env`，并准备 Node.js、pnpm、PostgreSQL 与 Redis。

```bash
pnpm install                 # 安装依赖；postinstall 自动生成 Prisma client
pnpm prisma:push             # db push 后重新生成 client
pnpm dev                     # Turbopack，127.0.0.1:3000
pnpm dev:webpack             # Webpack 开发服务器
pnpm test                    # 全量 Vitest
pnpm test -- path/to/foo.test.ts
pnpm typecheck               # tsc --noEmit
pnpm lint                    # eslint . 全仓
pnpm lint:fix
pnpm format                  # Prettier 写入全仓库，仅在明确需要时运行
pnpm build                   # Next standalone；随后自动执行 postbuild
pnpm build:sitemap
pnpm prisma:generate
```

可选搜索运维：`pnpm search:engine`、`pnpm search:init`、`pnpm search:sync-all`、`pnpm search:reconcile`、`pnpm search:setup`。生产脚本为 `pnpm deploy:install`、`pnpm deploy:build`、`pnpm start`/`pnpm stop`；这些命令会改数据库、拉取代码或操作 PM2，不用于普通本地验证。

## Code Conventions & Common Patterns

- 使用 `~/...` 根路径别名；类型导入使用 `import type`。React 组件/PascalCase 文件，普通 helper/camelCase；内部聚合 helper 常以 `_` 开头，项目 helper 常以 `kun` 开头。
- Prettier：单引号、无分号、2 空格、无尾逗号、LF。不要手工重排无关代码。
- 默认保留 Server Component；只有 hooks、浏览器 API、Zustand 或交互式 HeroUI 场景才加 `'use client'`。Server Action 文件显式加 `'use server'`。
- 新 API/表单边界先复用或补充 `validations/*.ts`，再通过 `kunParseGetQuery`、`kunParsePostBody`、`kunParsePutBody`、`kunParseDeleteQuery` 或 `kunParseFormData` 解析。Server Action 使用 `safeParseSchema`。
- 业务错误通常以 `NextResponse.json('中文错误消息')` 返回，部分认证/CSRF 路径设置 401/403；客户端按 `string | T` 使用 `kunErrorHandler`/`kunErrorHandlerAsync`，不要假设所有业务错误都有非 2xx 状态。
- 独立查询用 `Promise.all`；有顺序约束的事务、锁、缓存失效和外部副作用必须保持顺序。显式后台工作使用现有 `void ...catch(...)`、Next `after(...)` 或 Redis task lock 模式。
- 无 DI 容器：服务直接导入 `prisma`、Redis/S3 client。只有事务范围需要传播时才传 transaction client，不新增单实现接口或工厂。
- 跨组件/持久化数据使用现有 Zustand store；页面局部状态继续使用 React state。服务端初始数据通过 `initial*` props 水合，避免首屏重复请求。
- 搜索写入在数据库提交后调用现有 queue sync/remove helper；不要让 Meilisearch 可用性决定数据库写入是否成功。
- 不要手改 `prisma/generated/prisma/`、`public/sitemap.xml` 或 `.next/standalone/`；修改源 schema、路由、MDX 或构建脚本后重新生成。

## Important Files

- `package.json`：脚本、依赖、ESM 模式。
- `app/layout.tsx`、`app/providers.tsx`：根布局、会话水合和客户端 provider 栈。
- `app/[id]/page.tsx`：补丁详情入口和代表性的 Server Component 数据流。
- `utils/kunFetch.ts`、`utils/kunErrorHandler.ts`：客户端 API 与错误约定。
- `app/api/utils/parseQuery.ts`：Zod 请求解析入口。
- `app/api/utils/jwt.ts`、`middleware/_verifyHeaderCookie.ts`：Node/Edge 认证路径。
- `proxy.ts`、`middleware/_csrf.ts`：路由保护与 CSRF 策略。
- `prisma/index.ts`、`prisma.config.ts`、`prisma/schema/schema.prisma`：数据库 client、schema 路径和生成配置。
- `lib/redis.ts`、`lib/s3.ts`、`lib/meilisearch.ts`：基础设施适配器。
- `server/moderation/apply.ts`、`server/search/sync.ts`：审核事务和提交后搜索同步的代表实现。
- `next.config.ts`：MDX、图片域、standalone 输出和构建检查开关。
- `validations/dotenv-check.ts`、`.env.example`：启动时环境契约。
- `vitest.config.ts`：测试别名与发现规则。
- `instrumentation.ts`、`server/cron.ts`、`ecosystem.config.cjs`：cron 启动链路和 PM2 拓扑。
- `scripts/postbuild.ts`：sitemap 生成及 standalone 运行时资源复制。
- `.github/workflows/lint-check.yml`：CI 的 Node 版本与必跑检查。

## Runtime/Tooling Preferences

- 使用 Node.js + pnpm，不按 Bun 项目处理。CI 使用 Node 26；仓库当前没有 `engines` 或 `packageManager` 版本锁定，以 lockfile 和 CI 为准。
- `package.json` 为 ESM（`"type": "module"`）；TypeScript 运维脚本通过 `esno` 执行。
- TypeScript 为 strict、ESNext、bundler resolution、`noEmit`；别名 `~/*` 指向仓库根目录。
- Tailwind v4 仅通过 `postcss.config.js` 的 `@tailwindcss/postcss` 接入，没有 `tailwind.config.*`；主题入口使用现有样式文件，不新增旧版配置。
- Prisma 7 使用 PostgreSQL `pg` adapter；schema 根为 `prisma/schema/`，生成目录被忽略。schema 改动至少运行 `pnpm prisma:generate`，需要同步本地库时运行 `pnpm prisma:push`。
- `.env` 文件是启动/构建硬性前置，`validations/dotenv-check.ts` 会 fail fast。新增环境变量时同步 schema 与 `.env.example`。
- `pnpm build` 输出 Next standalone；postbuild 还会生成 sitemap，并复制 `public/`、`.next/static/`、`server/image/`、`posts/`、`config/redirect.json`。不要绕过该生命周期部署裸 `.next/standalone`。
- Meilisearch 由 `compose.yaml` 可选启动；运行时必须保留 Prisma fallback。S3、邮件、Cloudflare 等外部服务由环境变量配置，验证时避免真实生产资源。

## Testing & QA

- 测试框架为 Vitest；`vitest.config.ts` 只发现 `**/__tests__/**/*.test.ts`，别把测试放成 `.spec.ts` 或仓库外测试目录。
- 测试与实现同域放置，例如 `server/search/__tests__/filter-builder.test.ts`、`app/api/user/follow/__tests__/route.test.ts`、`app/api/patch/rating/__tests__/write-stat-transaction.test.ts`。
- 现有模式使用 `describe`/`it`/`expect`、`vi.hoisted` + `vi.mock` 隔离 Prisma、Next、认证、缓存、S3 与搜索；fixture 通常内联，`beforeEach` 重置并设置确定性返回值。
- 事务测试应验证可观察结果以及 lock/commit/rollback/retry 顺序；API 测试覆盖成功路径和业务错误字符串，不测试源码文本或实现细节。
- 修改行为后先运行对应文件：`pnpm test -- <path>`，再运行 `pnpm typecheck`。共享服务、事务或 CI 相关变更运行全量 `pnpm test`；路由、Next 配置、Prisma 或 standalone 变更再运行 `pnpm build`。
- CI 在 Node 26 上依次执行复制 `.env.example`（须在安装前，postinstall 的 `prisma generate` 依赖 `KUN_DATABASE_URL`）、安装、`pnpm prisma:generate`、`pnpm lint`、`pnpm typecheck` 和 `pnpm test`。
- 当前没有全局 test setup、快照、浏览器/E2E runner、真实集成数据库 harness 或覆盖率配置；没有数值覆盖率门槛。不要声称覆盖率或端到端验证，除非单独实际执行。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
