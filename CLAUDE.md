# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 完整的架构、目录说明与约定见根目录 **`AGENTS.md`**（权威详版）。本文件只保留高频命令和最关键的约定，刻意不与 `AGENTS.md` 重复；两者冲突时以 `AGENTS.md` 为准。

## 项目

TouchGal（`kun-touchgal-next`）：Next.js 16 App Router 的 Galgame 文化社区站点。技术栈为 React 19、TypeScript strict、HeroUI + Tailwind v4、Prisma 7 + PostgreSQL、Redis、S3；Meilisearch 为可选搜索后端，未启用或异常时回退 Prisma。包管理器是 **pnpm**；项目为 ESM（`"type": "module"`），TS 脚本通过 `esno` 执行。

## 常用命令

```bash
pnpm dev              # Turbopack 开发服务器 (127.0.0.1:3000)
pnpm dev:webpack      # 切回 webpack dev server
pnpm build            # 生产构建 (Next standalone)
pnpm test             # Vitest 全量 (vitest run)
pnpm test -- app/api/user/follow/__tests__/route.test.ts   # 运行单个测试文件
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint . 全仓 (lint:fix 可自动修复)
pnpm format           # prettier --write
pnpm db:new <slug>    # 改了 schema 后生成迁移草稿 → 手改 → pnpm db:snapshot (详见 AGENTS.md)
pnpm db:migrate       # 执行 db/migrations 下未执行的迁移
pnpm db:verify --prisma  # 只读校验库与迁移 / 快照 / schema 是否一致
pnpm prisma:push      # prisma db push + generate (只用于本地原型)
pnpm prisma:generate  # 仅重新生成 client
pnpm build:sitemap    # 生成 public/sitemap.xml
pnpm start / pnpm stop  # PM2 (ecosystem.config.cjs)
```

测试框架为 **Vitest**（`vitest.config.ts`），只发现 `**/__tests__/**/*.test.ts`——测试与实现同目录放在 `__tests__/` 下，不要用 `.spec.ts`。改动后的验证基线等同 CI（`.github/workflows/lint-check.yml`，Node 26）：`pnpm prisma:generate` → `pnpm lint` → `pnpm typecheck` → `pnpm test`；涉及路由 / 配置 / Prisma / standalone 时再加跑 `pnpm build`。

## 请求与数据流（核心）

- Server Component（`app/**/page.tsx`）→ `app/**/actions.ts` → service → `prisma` / `redis`。`actions.ts` 是只在服务端被 await 的页面读取器，首行 `import 'server-only'`，不写 `'use server'`（会把导出登记成可被直接 POST 的 Server Function；lint 的 `kun/inv-server-01` 执法）。
- Client Component → `utils/kunFetch.ts` → `app/api/**/route.ts`（`kunRoute`：Zod 校验 → 会话与能力门）→ service/cache → Prisma。
- `proxy.ts`（Next 16 前身为 `middleware.ts`）：对 `/api/*`（排除 `/api/upload/*`，其在 handler 内自行校验）做 CSRF；对 `/admin`、`/user`、`/edit` 做登录保护。
- 认证：JWT cookie 名 `kun-galgame-patch-moe-token`；proxy 用 `app/api/utils/jwtEdge.ts`，服务端的签发与解析只在 `server/auth/session.ts`（`establishKunSession` / `resolveKunSiteSession`），路由从 `kunRoute` 的 `actor` 取身份。
- 数据层入口：`prisma/index.ts`（Prisma 7 + pg pool）、`lib/redis.ts`、`lib/s3.ts`。Prisma model 拆分在 `prisma/schema/*.prisma`，生成到 `prisma/generated/prisma`。
- 库的结构与数据变更只走 `db/migrations/`（线性、只追加，已合入的文件不可改）；改 `prisma/schema` 必须同时新增迁移并刷新 `db/objects.snapshot.sql`，CI 的 `db-replay` job 执法。

## 必须遵守的约定

- 导入统一用路径别名 `~/*`（指向仓库根）。
- 默认保留 Server Component；只有 hooks、浏览器 API、交互式组件才加 `'use client'`。
- Route Handler 一律写成 `export const GET = kunRoute.get({ auth: 'public' | 'optional' | 'user', capability?, input?, handler })`（`app/api/utils/kunRoute.ts`）：`auth` 必填且为字面量（lint 的 `kun/inv-route-01` 执法），对游客开放的入口要在 `app/api/__tests__/routeManifest.test.ts` 写理由，清单快照 `__snapshots__/routeManifest.txt` 随声明一起改。
- 新增 API / 表单：先在 `validations/` 增加或复用 Zod schema，交给 `kunRoute` 的 `input`（内部调 `kunParseGetQuery` / `kunParsePostBody` / `kunParsePutBody` / `kunParseDeleteQuery` / `kunParseFormData`，返回 `T | string`，string 即校验失败的错误消息）。
- 客户端访问内部 API 一律走 `utils/kunFetch.ts`（自带 `credentials: 'include'` 与 `x-requested-with: kun-fetch`），不要手写重复 fetch；用 `kunErrorHandler` / `kunErrorHandlerAsync` 处理 `string | T` 返回值。
- 响应约定：handler 返回中文错误消息字符串即业务错误（`kunRoute` 以 200 回出），成功返回 typed 对象；要状态码或 cookie 时返回 `NextResponse`，原样透传。
- 评论 / 评价 / 资源的物理删除与 `status` 写入只走 `server/content/**` 的命令，在 `kunTx`（`server/db/tx.ts`）里调用；事务里的业务失败用 `ctx.fail`，不要 `return` 字符串（等于提交）。lint 的 `kun/inv-content-05/06` 执法。
- 删号只走 `server/account/deleteAccount.ts`（封禁先行 → 分批调用现成删除服务 → user 行锁下复核后收尾）；新增指向 user 的外键先在 `server/account/userReferences.ts` 归类为 cascade / set-null / purge（`prisma/__tests__/user-fk-actions.test.ts` 执法）。
- 权限判断走 `constants/permission.ts` 的 `can(subject, capability)` 与属性谓词，不写角色数字比较；需要操作者的服务收 `KunActor`（`constants/role.ts`，只由 `resolveKunSiteSession` 构造），路由把会话 payload 原样下传。lint 的 `kun/inv-authz-01..04` 执法。
- 请求视角（会话、作品可见性、列表缓存准入）只从 `server/viewer` 取：Route Handler 用 `viewerContextFromRequest(req)` 建一次后往下传，页面与读取器用 `getViewerContext()`；service 收 `PatchVisibility` / `ListView`，不收拼好的 `where`。lint 的 `kun/inv-viewer-01/02` 执法。
- 账户安全属性（密码、邮箱、2FA）的二次验证只走 `server/auth`：路由调 `requireStepUp`，要哪些因子由 `STEP_UP_POLICY` 一张表决定，并排在任何目标查重之前；TOTP / 备份码只经 `secondFactor.ts`，2FA 三列只由 `twoFactorState.ts` 条件写入，改邮箱走 `emailChange.ts` 的台账。`requireStepUp` 不放进事务；备份码由收 `StepUpPassed` 的状态迁移在自己的事务里消费。不要在路由里裸调 `time2fa`、`verifyPassword`、`checkTotp` 或 `consumeTwoFactorBackupCode`。写凭据与权限列（密码、邮箱、2FA、角色、封禁）一律经 `server/auth/securityEvents.ts` 的 `applyKunCredentialChange`，提交之后调 `finishKunSecurityEvent`；哪个事件刷新安全戳、登出哪些会话只写在 `KUN_SECURITY_POLICY`，路由不自己删会话键。lint 的 `kun/inv-auth-01..05` 执法。
- 项目自有 helper / export 多带 `kun` 前缀；跨组件、需持久化的状态放 `store/*`（Zustand）。
- 缓存 TTL 常量在 `config/cache.ts`，Redis key 统一经 `lib/redis.ts` 前缀。
- 代码风格（Prettier）：单引号、无分号、2 空格缩进、无尾逗号。
- 启动 / 构建前 `.env` 必须通过 `validations/dotenv-check.ts` 校验，否则会失败（参考 `.env.example`）。
