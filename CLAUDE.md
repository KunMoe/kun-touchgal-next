# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 完整的架构、目录说明与约定见根目录 **`AGENTS.md`**（权威详版）。本文件只保留高频命令和最关键的约定，刻意不与 `AGENTS.md` 重复；两者冲突时以 `AGENTS.md` 为准。

## 项目

TouchGal（`kun-touchgal-next`）：Next.js 16 App Router 的 Galgame 文化社区站点。技术栈为 React 19、TypeScript strict、HeroUI + Tailwind v4、Prisma 7 + PostgreSQL、Redis、S3；Meilisearch 为可选的搜索召回后端，列表与卡片以 PG 为准，未启用或它自身故障时回退 basic 引擎（Prisma）。包管理器是 **pnpm**；项目为 ESM（`"type": "module"`），TS 脚本通过 `esno` 执行。

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
pnpm start / pnpm stop  # PM2 (ecosystem.config.cjs)
```

测试框架为 **Vitest**（`vitest.config.ts`），只发现 `**/__tests__/**/*.test.ts`——测试与实现同目录放在 `__tests__/` 下，不要用 `.spec.ts`。改动后的验证基线等同 CI（`.github/workflows/lint-check.yml`，Node 26）：`pnpm prisma:generate` → `pnpm lint` → `pnpm typecheck` → `pnpm test`；涉及路由 / 配置 / Prisma / standalone 时再加跑 `pnpm build`。

## 请求与数据流（核心）

- Server Component（`app/**/page.tsx`）→ `app/**/actions.ts` → service → `prisma` / `redis`。`actions.ts` 是只在服务端被 await 的页面读取器，首行 `import 'server-only'`，不写 `'use server'`（会把导出登记成可被直接 POST 的 Server Function；lint 的 `kun/inv-server-01` 执法）。
- Client Component → `utils/kunFetch.ts` → `app/api/**/route.ts`（`kunRoute`：Zod 校验 → 会话与能力门）→ service/cache → Prisma。
- `proxy.ts`（Next 16 前身为 `middleware.ts`）：对 `/api/*` 的写方法做 CSRF（唯一豁免 `/api/user/setting/email/revert`，靠邮件里的一次性令牌）；对 `/admin`、`/user`、`/edit` 做登录保护。
- 认证：JWT cookie 名 `kun-galgame-patch-moe-token`；proxy 用 `app/api/utils/jwtEdge.ts`，服务端的签发与解析只在 `server/auth/session.ts`（`establishKunSession` / `resolveKunSiteSession`），路由从 `kunRoute` 的 `actor` 取身份。
- 数据层入口：`prisma/index.ts`（Prisma 7 + pg pool）、`lib/redis.ts`、`lib/s3.ts`。Prisma model 拆分在 `prisma/schema/*.prisma`，生成到 `prisma/generated/prisma`。
- 库的结构与数据变更只走 `db/migrations/`（线性、只追加，已合入的文件不可改）；改 `prisma/schema` 必须同时新增迁移并刷新 `db/objects.snapshot.sql`，CI 的 `db-replay` job 执法。

## 必须遵守的约定

- 导入统一用路径别名 `~/*`（指向仓库根）。
- 默认保留 Server Component；只有 hooks、浏览器 API、交互式组件才加 `'use client'`。
- Route Handler 一律写成 `export const GET = kunRoute.get({ auth: 'public' | 'optional' | 'user', capability?, input?, handler })`（`app/api/utils/kunRoute.ts`）：`auth` 必填且为字面量（lint 的 `kun/inv-route-01` 执法），对游客开放的入口要在 `app/api/__tests__/routeManifest.test.ts` 写理由，清单快照 `__snapshots__/routeManifest.txt` 随声明一起改。
- 新增 API / 表单：先在 `validations/` 增加或复用 Zod schema，交给 `kunRoute` 的 `input`（内部调 `kunParseGetQuery` / `kunParsePostBody` / `kunParsePutBody` / `kunParseDeleteQuery` / `kunParseFormData`，返回 `T | string`，string 即校验失败的错误消息）。
- 客户端访问内部 API 一律走 `utils/kunFetch.ts`（自带 `credentials: 'include'` 与 `x-requested-with: kun-fetch`），不要手写重复 fetch。`kunFetch` 不为请求失败抛异常：断网、非 2xx 与业务失败都是 `string` 返回值（返回类型 `T | string`），调用点只写一条失败分支（`kunErrorHandler(res, callback)` 或 `typeof res === 'string'`），只有成功才该做的事放在成功分支里；返回值不得以语句形式丢弃（lint 的 `kun/inv-fetch-01` 执法，确实不看结果写 `void`）。只有必须分清「请求没有得到 2xx 应答」的站点（登出、2FA 临时令牌检查、输入中静默的自动搜索）才用 `isKunTransportFailure`。
- 响应约定：handler 返回中文错误消息字符串即业务错误（`kunRoute` 以 200 回出），成功返回 typed 对象；要状态码或 cookie 时返回 `NextResponse`，原样透传。
- 实体页的「不存在」：共享 service 返回 `null`，页面读取器（`actions.ts`）调 `notFound()`，由 `app/not-found.tsx` 渲染；service 与 Route Handler 里不调 `notFound()`，文案只在路由边界产生。`/[id]`、`/[id]/resource/[resourceId]`、`/company/[id]` 上方不加 `loading.tsx` / Suspense（否则 404 退化成 200）。
- 页面 metadata 与抓取契约：不带 `generateMetadata` 的页面在 `metadata.ts`（一般在同目录）写 `kunPageMetadata({ title, ... })`（`utils/pageMetadata.ts`），页面原样转出为 `metadata`。`title` 只写页面名（站点后缀只由根布局的 `title.template` 补，客户端改标题用 `kunDocumentTitle`），不手写 canonical / `og:url` / `openGraph`（根布局与工厂给的 `'./'` 由 Next 按当前 pathname 解析），中间的 layout 不声明 `title`。新增 `page.tsx` 要在 `config/routePolicy.ts` 的 `KUN_ROUTE_POLICY` 登记 `listed` / `unlisted` / `noindex` / `blocked`：`app/robots.ts` 与运行期的 `app/sitemap.ts`（`server/sitemap/`，构建期不查库）都从它派生，`public/` 下不放 `robots.txt` / `sitemap.xml`（会顶替路由，`prebuild` 会拒绝构建）。护栏 `app/__tests__/page-metadata.test.ts` 重放 Next 的解析结果（带 `generateMetadata` 的 page / layout 要在它的 `DYNAMIC_LAYERS` 里登记夹具），`config/__tests__/routePolicy.test.ts` 核对登记。
- 评论 / 评价 / 资源的物理删除与 `status` 写入只走 `server/content/**` 的命令，在 `kunTx`（`server/db/tx.ts`）里调用；事务里的业务失败用 `ctx.fail`，不要 `return` 字符串（等于提交）。lint 的 `kun/inv-content-05/06` 执法。
- 事务一律经 `kunTx` 开启，不直接调 `prisma.$transaction`（lint 的 `kun/inv-tx-01` 执法）：失败但已做的写入要提交时 `return ctx.commitWith(消息)`；可丢失的提交后副作用用 `ctx.afterCommit`；没提交时的清理用 `onRollback`（选项里的管事务前已存在的产物，`ctx.onRollback` 管回调里才产生的），不要挂 `.catch`；违例文案用 `violations` 选项；回调的输出只走返回值，不写外层变量。
- 靠 Prisma 编译出的 SQL 形状才成立的写法（条件 `updateMany` 的 `count` 当 CAS、`_count` 里对返回行恒真的过滤）与 adapter 的错误映射由不连库的编译契约守护，随 `pnpm test` 运行：`prisma/__tests__/compile-contract.test.ts`、`error-contract.test.ts` 与各站点的 `__tests__/*.sql.test.ts`（录制客户端 `prisma/__tests__/support/sqlRecorder.ts`）。新增这类写法要配 `*.sql.test.ts`；升级 prisma / adapter / pg 后变红，先判断新形状是否仍满足前提，不要机械改断言。`PrismaClient` 只在 `prisma/createClient.ts` 构造。
- 删号只走 `server/account/deleteAccount.ts`（封禁先行 → 分批调用现成删除服务 → user 行锁下复核后收尾）；新增指向 user 的外键先在 `server/account/userReferences.ts` 归类为 cascade / set-null / purge（`prisma/__tests__/user-fk-actions.test.ts` 执法）。
- 权限判断走 `constants/permission.ts` 的 `can(subject, capability)` 与属性谓词，不写角色数字比较；需要操作者的服务收 `KunActor`（`constants/role.ts`，只由 `resolveKunSiteSession` 构造），路由把会话 payload 原样下传。lint 的 `kun/inv-authz-01..04` 执法。
- 请求视角（会话、作品可见性、列表缓存准入）只从 `server/viewer` 取：Route Handler 用 `viewerContextFromRequest(req)` 建一次后往下传，页面与读取器用 `getViewerContext()`；service 收 `PatchVisibility` / `ListView`，不收拼好的 `where`。lint 的 `kun/inv-viewer-01/02` 执法。
- 账户安全属性（密码、邮箱、2FA）的二次验证只走 `server/auth`：路由调 `requireStepUp`，要哪些因子由 `STEP_UP_POLICY` 一张表决定，并排在任何目标查重之前；TOTP / 备份码只经 `secondFactor.ts`，2FA 三列只由 `twoFactorState.ts` 条件写入，改邮箱走 `emailChange.ts` 的台账。`requireStepUp` 不放进事务；备份码由收 `StepUpPassed` 的状态迁移在自己的事务里消费。不要在路由里裸调 `time2fa`、`verifyPassword`、`checkTotp` 或 `consumeTwoFactorBackupCode`。写凭据与权限列（密码、邮箱、2FA、角色、封禁）一律经 `server/auth/securityEvents.ts` 的 `applyKunCredentialChange`，提交之后调 `finishKunSecurityEvent`；哪个事件刷新安全戳、登出哪些会话只写在 `KUN_SECURITY_POLICY`，路由不自己删会话键。lint 的 `kun/inv-auth-01..05` 执法。
- 按用户名、邮箱找人与查重只走 `server/identity/lookup.ts`：登录 `findUserForLogin(classifyLoginIdentifier(name))`（邮箱形态只查 email 列、用户名形态只查 name 列，不写双列 `OR`，不回落），查重 `isUsernameTaken` / `isEmailTaken` 的 `exceptUid` 必填；匹配是原生 SQL 的 `lower(列) = lower(输入)`、走 `lower()` 唯一索引，不要改回 `{ equals, mode: 'insensitive' }`（ILIKE 顺扫全表，真库用例的 EXPLAIN 会红）；模块外的 user 读查询不按 name / email 精确匹配（lint 的 `kun/inv-identity-02` 执法）。「是不是邮箱形态」只由 `validations/identifier.ts` 判定，`raw` 不预先小写（验证码 Redis 键是裸邮箱）。取新名字的规则（保留词、不得为邮箱形态）只有 `server/identity/username.ts` 的 `newUsernameError`，管理端只在改了名时调。库层由 `lower(name)` / `lower(email)` 唯一索引兜底（迁移 0018），预检不要删。
- 审核任务的失败归因只在 `server/moderation`：调用依赖的边界（`ai.ts`、头像的 S3 调用点）用 `lib/resilience/failure.ts` 把失败说成带范围的 `DependencyFailure`，worker 不从错误的样子猜（没带范围的一律 `internal`）；每条车道（文本 / 头像）一个熔断器（`breaker.ts`），记账只走 `accounting.ts` 的 `decideFailureAccounting`，按「记录这次失败之前」的车道状态决定扣 `defer_count`、扣 `retry` 还是不扣。不要改成按记录之后的状态归因，也不要让依赖类失败不计数。拿了探测名额的路径必须回报结果或 `releaseProbe()`。转人工经 `markTaskManual(id, { kind, reason })`，类别写 `failure_kind`。车道打开期间任务留在待审核、不转人工（缺模型的地址或密钥也算：不要靠删配置来关审核）；探测取没失败过的任务里最新到的那一条，不按就绪时刻取。`MODERATION_SYSTEMATIC_DETECTION` 现为 `log`（系统性故障只记日志、不打开车道），改成 `enforce` 之前先看生产日志；裁决缓存键含策略身份（`policy.ts` 的 `textId`）。
- 作品列表与搜索卡片以 PG 为准，Meilisearch 只负责召回：`queryGalgameIds`（`server/search/query.ts`）只返回 id 与总数，卡片一律经 `fetchGalgameCardsByIds(ids, visibility)`（`server/galgame/cards.ts`）回 PG 取并重新裁决可见性（只重判可见性，标签 / 会社成员与筛选仍以索引为准）；不要从索引文档映射卡片，也不要把字段加回 `attributesToRetrieve`。用哪个引擎只由 `server/search/failure.ts` 的 `withMeiliEngine` 决定（`isMeiliEnabled` 只许它导入、`queryGalgameIds` 只许登记的调用方导入，lint 的 `kun/inv-search-01/02` 执法）：只有 Meilisearch 自身的故障才换到 basic 引擎（不可用记 warn，索引没配好或应答不是 Meilisearch 的记 error），请求参数被拒抛 `MeiliBadRequestError`、由调用方翻成业务错误，其余异常原样抛出；分类按错误的 `name` 与错误码，不用 `instanceof`。关键词搜索的 basic 引擎在 `server/galgame/basicSearch.ts`，与 Meilisearch 不等价，`/api/search` 的响应带 `engine`。
- 群发邮件只走 `server/mail/campaign.ts`：路由只建任务（`createCampaign`，通告锁 `(481005, 0)` 下查后插，同一时刻至多一个进行中的任务），发信由 cron 进程的 `mailCampaignTask` 每分钟调 `runCampaignStep` 按游标推进。先发一批、再推进游标（至少一次，重复上界一批），不要改成先推进后发送；发信前的认领 / 推进 / 暂停 / 收尾 / 取消 / 继续都是平铺 WHERE 的条件 `updateMany`，命中 0 行就停，不在别处写 `mail_campaign` 的 `status` 或游标（`campaign.sql.test.ts`、`campaign.db.test.ts` 守护）。一批里失败达到一半即自动暂停在这一批之前（不推进游标，继续时整批重发；不足半批的尾批不判），判据与节奏常量在 `constants/admin.ts` 的 `MAIL_CAMPAIGN_*`。任务只在发起它的站点地址上被推进（`site_origin`）：随数据库副本带到开发 / 测试环境的任务不会接着发。模板经 `constants/email/campaign.ts` 的 `renderCampaignEmail`（槽位是受信 HTML，不做占位符替换，预览与发信同一个函数）；退订链接是 `server/mail/unsubscribeToken.ts` 对 uid 的 HMAC（`KUN_EMAIL_UNSUBSCRIBE_SECRET`），发信不写 Redis。
- 会让别人承担成本的写入口（评论、评价、举报、反馈、私信、外部抓取、moyu）的频率预算只在 `server/abuse/`：策略一张表（`policies.ts`，新行先 `observe`、看统计再改 `enforce`），路由在 `kunRoute` 的 `abuse` 字段里声明，按成本计的（提及按新增收件人）在属主处调 `reserveAbuseBudget`；计数 Lua 全仓只有 `windowCounter.ts` 一份（`server/auth/attemptBudget.ts` 是它的封装），不要另写。频率预算 Redis 出错时放行，凭据预算 fail-closed。声明了 `abuse` 的路由在测试里要 mock `~/server/abuse/budget`（单测连不上 Redis，`vitest.config.ts` 的 `test.env` 所致，不 mock 门就放行、等于没测）。送审第一段按提交者限在途任务数（`MODERATION_MAX_PENDING_PER_USER`），限的是数量不是速率，不要换成入口窗口；它是先查后写，并发能越过（编辑没有入口预算兜底），车道打开或 worker 停摆时会挡住所有送审提交。
- 资源直传的暂存 → 转正只走 `server/storage/stagedUpload.ts`（上传令牌、暂存对象校验、转正后的元数据都在这里定）；对象名只取 `utils/safeObjectName.ts` 的 `toSafeObjectName`，返回 `null` 即拒绝。不在别处拼 `patch/tmp/` 的 key 或解析上传令牌；转正用 `lib/s3.ts` 的 `promoteObject`，不用 `copyObject`（它继承上传者写入的元数据）。
- 人机验证的界面由本站自己画（`components/kun/auth/CaptchaModal.tsx`），厂商的 `cap-widget` 只经 `useKunCap.ts` 当看不见的求解引擎用（`new Cap(...)`，只取模块的 `default`）：不把 `<cap-widget>` 渲染进页面，不给它打补丁；`useKunCap` 在常驻挂载的组件里调用，关闭弹窗即同步销毁实例，关闭后不得再触发 `onSuccess`。`cap-widget` 钉精确版本，与 `public/cap/` 下自托管的 wasm 由 `components/kun/auth/__tests__/capVendorContract.test.ts` 核对；升级后在 `next dev` 与生产构建上各冒烟一次（清单见 `AGENTS.md`）。
- 客户端列表的取数生命周期（只让最新请求落地、写后刷新取当前查询、越界钳制、失败即停、追加去重、删行退页或补齐、键变化后旧数据失效、分块批量可停止）只写在 `utils/list/kunListMachine.ts`：分页列表用 `hooks/useKunPagedList.ts`，无限滚动用 `useKunInfiniteList.ts`，单键取数用 `useKunKeyedQuery.ts`，分块批量用 `useKunChunkedBatch.ts`；不要再照抄 `*RequestIdRef` 守卫或自建 `IntersectionObserver`（lint 的 `kun/inv-list-01` 执法，存量在 `eslint-suppressions.json`）。批量目标只取 `selection.ids`。服务端实体字段归持有列表的组件、叶子交互组件受控；共享写组件（`UserFollow`）只经 `onChange` 上报，刷新与否由宿主决定（`/[id]` 上不刷新）。
- 项目自有 helper / export 多带 `kun` 前缀；跨组件、需持久化的状态放 `store/*`（Zustand）。
- 会被写回库的表单不从展示用的缓存预填：Galgame 重写页 `/edit/rewrite/[uniqueId]` 自己经 `getGalgameForRewrite` 读库，表单 store 是用这份基线初始化的页内实例。`PUT /api/edit` 的标签是按 id 的差量（`removeTagIds` + `addTagNames`，只走 `applyManualTagChange`），并带 `baseFingerprint` 做并发检查（规范化与指纹只在 `app/api/edit/_editFields.ts`；事务里锁 patch 行用 `FOR UPDATE`）。建档 / 重写的表单 store 改字段只有 `update(patch | fn)`，`await` 之后写表单用函数式；抓取结果经 `components/edit/form/merge.ts` 的纯函数并入。
- 共享读缓存的失效知识只在 `server/cache/plan.ts`：写路径在 `kunTx` 回调里用 `recordKunChanges(ctx, changes)` 报告改了哪一行与前后状态（只取行锁下读值或 `RETURNING`），要失效哪些缓存由规划器推导、提交后逐条执行且不抛错；资源族四个失效 helper 只许 `server/cache/**` 引用（`kun/inv-cache-01`）。被内嵌却刻意不精确失效的字段登记在 `KUN_TTL_TOLERATED`（带陈旧上限，TTL 调长超过它测试变红）。
- 缓存 TTL 常量在 `config/cache.ts`，Redis key 统一经 `lib/redis.ts` 前缀。
- 代码风格（Prettier）：单引号、无分号、2 空格缩进、无尾逗号。
- 启动 / 构建前 `.env` 必须通过 `validations/dotenv-check.ts` 校验，否则会失败（参考 `.env.example`）。
