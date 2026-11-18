# Repository Guidelines

## Project Overview

TouchGal (`kun-touchgal-next`) 是一个基于 Next.js 16 App Router 的 Galgame 文化社区站点，提供作品/补丁资料、资源下载、评分评论、用户主页、私信、后台管理、OIDC 和 MDX 内容页。

主栈为 React 19、TypeScript strict、HeroUI、Tailwind CSS v4、PostgreSQL + Prisma 7、Redis 和 S3 兼容对象存储；Meilisearch 为可选搜索后端，未启用或异常时回退到 Prisma。

## Architecture & Data Flow

- `app/**/page.tsx` 默认是 Server Component。列表/详情页通常调用同目录 `actions.ts`，由这个只在服务端被 await 的页面读取器复用 `app/api/**/service.ts`，再访问 Prisma、Redis 或 Meilisearch；需要交互时将 `initial*` 数据传给 Client Component。
- 浏览器交互路径为 Client Component → `utils/kunFetch.ts` → `app/api/**/route.ts` → `app/api/utils/parseQuery.ts` + `validations/*.ts` → JWT/角色/所有权校验 → service → Prisma/缓存。不要在组件内重复实现内部 fetch 包装。
- Route Handler 保持薄：解析、鉴权、分派和 `NextResponse.json`；查询、事务和 DTO 转换放同目录 `service.ts`、HTTP 动词文件或共享 helper。
- PostgreSQL 统一通过 `prisma/index.ts` 的单例访问。多表变更与审计日志使用 `prisma.$transaction`；可复用 helper 接收 transaction client。提交后再失效 Redis、刷新用户会话或排队同步搜索。
- Redis key 经 `lib/redis.ts` 统一加 `kun:touchgal` 前缀。共享内容缓存必须包含可见性条件；管理员、作者或待审核内容需要按现有逻辑绕过共享缓存。列表类的共享缓存只对 `ListView` 的 `shared` 视角读写，键里的视角段用 `toCacheVariant(view)` 从视角现算，不要从 Prisma `where` 反推，也不要另传一个键。
- S3 上传先进入临时 key，校验对象后复制到最终位置。数据库事务提交后再执行对象复制/删除等外部副作用，参考 `app/api/patch/resource/_helper.ts`。
- `proxy.ts`（Next 16 前身为 `middleware.ts`）为写 API 执行 CSRF 检查并保护 `/admin`、`/user`、`/edit` 等页面；上传 API 因请求体限制在 handler 内自行校验。认证 cookie 为 `kun-galgame-patch-moe-token`。
- `instrumentation.ts` 仅在 Node runtime 且 `KUN_ENABLE_CRON=true` 时加载 `server/cron.ts`。生产由 PM2 分离普通 Web worker 与单个 cron worker；任务使用 Redis 锁避免重复执行。

## Key Directories

- `app/`：App Router 页面、布局、页面读取器（`actions.ts`）、Route Handlers、错误/元数据边界及 OIDC 路由。
- `app/api/`：HTTP 边界和主要领域服务；复杂查询或写入不要堆在 `route.ts`。
- `components/`：按 `patch`、`resource`、`search`、`user`、`admin` 等领域组织的 UI；`components/kun/` 为共享组件。
- `store/`：Zustand 状态；持久状态使用 `persist`，简单表单状态留在组件内。
- `validations/`：API 与页面读取器共用的 Zod schema，包含中文用户错误信息。
- `prisma/schema/`：拆分的 PostgreSQL schema；生成 client 位于 `prisma/generated/prisma/`。
- `db/`：数据库结构与数据变更的唯一通道。`db/migrations/` 是线性、只追加的 SQL 迁移；`db/objects.snapshot.sql` 是回放生成的库级对象快照（函数、触发器、部分索引）；工具在 `scripts/db/`。
- `lib/`：Redis、S3、Meilisearch、OIDC、MDX 和第三方集成。
- `server/`：cron 编排、定时任务、审核流水线和搜索索引同步；`server/viewer/` 是请求视角（会话、作品可见性、列表缓存准入）的唯一来源；`server/content/` 是评论 / 评价 / 资源的删除、状态迁移与编辑命令，`server/db/tx.ts` 是这些命令使用的事务执行器 `kunTx`。
- `middleware/`：JWT、cookie 与 CSRF 实现。
- `utils/`：fetch、错误处理、cookie、Markdown、URL/文件名安全处理及页面读取器 helper（`utils/actions/`）。
- `constants/`、`types/`、`config/`：领域常量/Prisma select、API DTO 和运行时配置。
- `scripts/`：构建后复制、sitemap、搜索、部署、OIDC 和数据回填脚本。
- `migration/`：人工执行的一次性数据脚本与同步作业，不得当作常规工作流运行；库的结构变更不放这里，走 `db/migrations/`。`migration/backup/` 只放这些脚本的运行产物（缓存、报告、数据备份），整个目录被 git 忽略，也被排除在 standalone 构建之外。
- `posts/`、`public/`：运行时 MDX 内容和静态资源；两者参与 standalone 构建复制或 sitemap 生成。

## Development Commands

先复制 `.env.example` 为 `.env`，并准备 Node.js、pnpm、PostgreSQL 与 Redis。

```bash
pnpm install                 # 安装依赖；postinstall 自动生成 Prisma client
pnpm db:migrate              # 按序执行 db/migrations 下未执行的迁移（新库从空库建起，含触发器）
pnpm db:new <slug>           # 改了 prisma/schema 之后生成迁移草稿（需要 KUN_DB_SCRATCH_URL）
pnpm db:snapshot             # 新增或修改迁移后重新生成 db/objects.snapshot.sql
pnpm db:verify --prisma      # 只读校验：台账、INVALID 索引、库级对象、表结构
pnpm db:inspect              # 只读盘点一个库的实际状态
pnpm prisma:push             # db push 后重新生成 client；只用于本地原型
pnpm dev                     # Turbopack，127.0.0.1:3000
pnpm dev:webpack             # Webpack 开发服务器
pnpm test                    # 全量 Vitest
pnpm test -- path/to/foo.test.ts
pnpm typecheck               # tsc --noEmit
pnpm lint                    # eslint . 全仓；规则只有 error / off，存量违规记在 eslint-suppressions.json
pnpm lint:fix
pnpm lint:prune              # 修掉存量违规、删除或改名文件后收紧基线
pnpm format                  # Prettier 写入全仓库，仅在明确需要时运行
pnpm build                   # Next standalone；随后自动执行 postbuild
pnpm build:sitemap
pnpm prisma:generate
```

可选搜索运维：`pnpm search:engine`、`pnpm search:init`、`pnpm search:sync-all`、`pnpm search:reconcile`、`pnpm search:setup`。生产脚本为 `pnpm deploy:install`、`pnpm deploy:build`、`pnpm start`/`pnpm stop`；这些命令会改数据库、拉取代码或操作 PM2，不用于普通本地验证。

## Code Conventions & Common Patterns

- 使用 `~/...` 根路径别名；类型导入使用 `import type`。React 组件/PascalCase 文件，普通 helper/camelCase；内部聚合 helper 常以 `_` 开头，项目 helper 常以 `kun` 开头。
- Prettier：单引号、无分号、2 空格、无尾逗号、LF。不要手工重排无关代码。
- 默认保留 Server Component；只有 hooks、浏览器 API、Zustand 或交互式 HeroUI 场景才加 `'use client'`。`actions.ts` 与 `utils/actions/` 是页面读取器，首行写 `import 'server-only'`，不写 `'use server'`：那个指令不是「仅服务端」标记，它会把每个导出登记成可被直接 POST 的 Server Function（入参来自客户端，也不经页面守卫）。全仓目前没有由客户端调用的 Server Function，`kun/inv-server-01` 拦住这个指令；确实需要时把文件加进该条的 `ignores`，并在函数内自行校验入参与鉴权。
- 新 API/表单边界先复用或补充 `validations/*.ts`，再通过 `kunParseGetQuery`、`kunParsePostBody`、`kunParsePutBody`、`kunParseDeleteQuery` 或 `kunParseFormData` 解析。页面读取器使用 `safeParseSchema`。
- 业务错误通常以 `NextResponse.json('中文错误消息')` 返回，部分认证/CSRF 路径设置 401/403；客户端按 `string | T` 使用 `kunErrorHandler`/`kunErrorHandlerAsync`，不要假设所有业务错误都有非 2xx 状态。
- 独立查询用 `Promise.all`；有顺序约束的事务、锁、缓存失效和外部副作用必须保持顺序。显式后台工作使用现有 `void ...catch(...)`、Next `after(...)` 或 Redis task lock 模式。
- 无 DI 容器：服务直接导入 `prisma`、Redis/S3 client。只有事务范围需要传播时才传 transaction client，不新增单实现接口或工厂。
- 跨组件/持久化数据使用现有 Zustand store；页面局部状态继续使用 React state。服务端初始数据通过 `initial*` props 水合，避免首屏重复请求。
- 搜索写入在数据库提交后调用现有 queue sync/remove helper；不要让 Meilisearch 可用性决定数据库写入是否成功。
- 评论、评价、资源三张内容表的物理删除与 `status` 写入只出现在 `server/content/**` 内（`kun/inv-content-05`、`kun/inv-content-06` 执法）。入口只做三件事：算出数据形状的守卫（`statusIn`、`ownerUid`），在 `kunTx` 里调用 `plan*Removal` / `execute*Removal`、`transition*`、`edit*`，把命令返回的 `skipped` 映射成自己的文案。命令在行锁下复检守卫，锁序固定为「内容行 → 审核任务」，并按实际发生的前后状态登记提交后的缓存失效与通知（`server/content/changes.ts`），入口不要再手写这些失效。
- `server/content` 的命令按同一个方向加锁：内容行（按 id 升序，`FOR UPDATE`）→ patch 行（按 id 升序）→ 审核任务 / 申诉 / 举报行；patch 通告锁总在 patch 行之后。新写的事务不要反着拿，几处容易写反的地方：要认领申诉 / 举报行并删除或迁移内容的入口，认领之前先锁内容行；计数触发器是行级的，一批内容跨多个补丁时在第一条写语句之前调 `lockPatchRows`（`server/content/patchLock.ts`）；`recalcPatchType` 自己先锁 patch 行再取通告锁；删评论要把整棵回复子树锁住；往内容行下面挂东西的插入（回复、资源评论）在事务里按「资源 → 补丁 → 父评论」取 `FOR KEY SHARE`，与级联删除同向。锁 patch 行用 `FOR NO KEY UPDATE`，`FOR UPDATE` 会与并发 INSERT 经外键取的 `FOR KEY SHARE` 冲突。这个方向还没有覆盖到作者的 user 行：前台删资源与审核裁决是先锁 user 行再锁内容行，点赞、申诉处理、资源初审则是先碰内容行、后写作者的 user 行（通知、萌萌点），与删号的级联方向相反。
- `kunTx` 的回调不能返回字符串：`prisma.$transaction` 的回调 `return` 字符串等于提交。类型上连 `{}`、`unknown`、`any` 也不接受（字符串能赋给它们，`'消息' | {}` 会被约简成 `{}`）：没有值可返回的回调就不 `return`，由入口写 `return failure ?? {}`。业务失败用 `ctx.fail(message)`（回滚，`kunTx` 以该消息为结果）；可丢失的提交后副作用用 `ctx.afterCommit(key, effect)` 登记，必须成功的写入（审计日志等）留在事务内。
- 权限规则只有一份：角色在 `constants/role.ts`（`KUN_ROLE`、`KunRole`），能力与阈值在 `constants/permission.ts` 的 `KUN_CAPABILITY`。服务端执法与客户端的显隐、置灰都调 `can(subject, capability)` 或同文件的属性谓词（`allowedLinkStorages`、`findDisallowedLinkStorage`、`canAssignRole`），不要再写 `role < 3` 这类比较，也不要在组件里另抄一份规则（`kun/inv-authz-01` 执法）。调整阈值只改表里一行，并同步 `posts/notice/role.mdx` 的总览表（`constants/__tests__/permission-matrix.test.ts` 逐格对照）。拒绝文案留在调用点，表里不放。
- 需要知道「谁在操作」的服务函数收 `KunActor`，不收 `uid` 加 `role` 两个数字。`KunActor` 带编译期品牌，只在 `app/api/utils/jwt.ts` 的 `verifyAndLoadUser` 构造（角色取自库或鉴权缓存），路由把 `verifyHeaderCookie` 的返回值原样往下传；测试用 `app/api/utils/__tests__/kunTestActor.ts`。`as KunActor`、展开之后覆写 `role`、在测试之外导入 `kunTestActor` 由 `kun/inv-authz-02`、`kun/inv-authz-03`、`kun/inv-authz-04` 拦住；品牌防的是写错，不是安全边界。属性规则（这份输入对这个操作者是否允许，例如存储 × 分区、可授予的角色）放在前台路由与后台包装共同经过的服务里，不挂在某一个路由上；编辑时只有原样带回的存量才不判，并在行锁下以当前数据再判一次（参考 `app/api/patch/resource/storageGate.ts`）。
- 请求视角只有一个来源：`server/viewer/context.ts` 的 `createViewerContext`。Route Handler 用 `viewerContextFromRequest(req)`（`server/viewer/fromRequest.ts`）建一次后往下传；页面、布局与页面读取器用 `getViewerContext()`（`server/viewer/fromHeaders.ts`），它靠 React `cache` 让一次渲染共用同一个上下文，而 `cache` 在 Route Handler 里不去重，所以 `app/api/**` 与 Route Handler 不得导入它，也不得导入 `utils/actions` 的请求 helper 和页面读取器（`kun/inv-viewer-01`，只认直接的静态导入）。同一个上下文里会话至多校验一次（校验带登录会话的续期与清理）。页面侧 `utils/actions/verifyHeaderCookie` 与 `getViewerContext()` 取到的是同一个上下文，可以混用；Route Handler 里每调一次 `verifyHeaderCookie(req)` 或 `viewerContextFromRequest(req)` 都新建一个上下文：只要 payload 的路由沿用 `verifyHeaderCookie(req)`，还要可见性的路由只建一个上下文，用它的 `viewer()`、`visibility()`、`listView()`，不要再另调 `verifyHeaderCookie(req)`（`server/viewer/__tests__/single-verification.test.ts` 逐路由数校验次数）。
- service 收类型化的视角，不收拼好的 `where`，也不收 `(viewer, bypassCache)` 这类松散参数：作品可见性收 `PatchVisibility`，由 `toPatchWhere` 给 Prisma、`toSearchVisibility` 给 Meilisearch；带共享缓存的列表收 `ListView`（作品列表不含待审核内容，收不带 `personal` 的 `PublicListView`）。`shared` 视角在类型上没有 viewer、屏蔽标签只能为空，共享缓存键的视角段只能由 `toCacheVariant(view)` 从它自己的 `visibility` 算出，所以键与查询条件同源；带屏蔽标签的视角是 `filtered`，按公开基线查询且不进共享缓存（屏蔽标签取自客户端的镜像 cookie，进了键就由客户端决定键的数量）；能看到待审核内容的用户是 `personal`。这些类型约束防的是写错，不是安全边界（结构类型拦不住多带字段的对象，也拦不住构造之后再改数组）：视角一律由上下文的 `listView()` 给出，不要手写。给 `PatchVisibility` 加字段时，缓存键的视角段与 Meilisearch 投影会编译失败，照提示补上（新字段会自动进键）。分级设置 cookie 没有签名，只对有效会话采信，服务端只在 `context.ts` 读它（`kun/inv-viewer-02` 按字符串字面量全仓执法）。屏蔽列表只取鉴权结果（库或鉴权缓存，改屏蔽时由 `invalidateUserSession` 失效），客户端只在 `userStore` 里留一份给界面用，不再写进 cookie；不要把它放回设置 store 或让服务端去读客户端带来的副本。设置 store（`store/settingStore.ts`）只持久化分级设置，`userStore.setUser` / `logout` 不碰它：登录态整页加载不写 cookie。
- 跨文件承重规则（如「zod 只许命名空间导入」）在 `lint/kunInvariants.mjs` 逐条登记为 `kun/inv-*`，每条带能报错的 bad 样例，由 `lint/__tests__/kunInvariants.test.ts` 执行。不要在 `eslint.config.mjs` 新增核心 `no-restricted-imports` / `no-restricted-syntax` 块：flat config 里同名规则带选项即整体替换，会静默关掉别处的禁令。新规则的存量违规要么清零，要么记入基线；`eslint-suppressions.json` 只减不增：修掉存量违规后不跑 `pnpm lint:prune`，lint 会以退出码 2 失败；基线按路径记账，删除文件后同样要跑 `pnpm lint:prune` 清掉残留条目（有测试守护），改名后旧额度不会转移到新路径，新路径上的存量要么修掉，要么用 `eslint <新路径> --suppress-rule <规则>` 重新登记。
- 不要手改 `prisma/generated/prisma/`、`public/sitemap.xml` 或 `.next/standalone/`；修改源 schema、路由、MDX 或构建脚本后重新生成。

## Important Files

- `package.json`：脚本、依赖、ESM 模式。
- `app/layout.tsx`、`app/providers.tsx`：根布局、会话水合和客户端 provider 栈。
- `app/[id]/page.tsx`：补丁详情入口和代表性的 Server Component 数据流。
- `utils/kunFetch.ts`、`utils/kunErrorHandler.ts`：客户端 API 与错误约定。
- `app/api/utils/parseQuery.ts`：Zod 请求解析入口。
- `app/api/utils/jwt.ts`、`middleware/_verifyHeaderCookie.ts`：Node/Edge 认证路径。
- `server/viewer/context.ts`、`server/viewer/patchVisibility.ts`：请求视角与作品可见性的唯一定义。
- `proxy.ts`、`middleware/_csrf.ts`：路由保护与 CSRF 策略。
- `prisma/index.ts`、`prisma.config.ts`、`prisma/schema/schema.prisma`：数据库 client、schema 路径和生成配置。
- `lib/redis.ts`、`lib/s3.ts`、`lib/meilisearch.ts`：基础设施适配器。
- `server/moderation/apply.ts`、`server/search/sync.ts`：审核事务和提交后搜索同步的代表实现。
- `next.config.ts`：MDX、图片域、standalone 输出和构建检查开关。
- `validations/dotenv-check.ts`、`.env.example`：启动时环境契约。
- `vitest.config.ts`：测试别名（含把 `server-only` 指到空模块）与发现规则。
- `instrumentation.ts`、`server/cron.ts`、`ecosystem.config.cjs`：cron 启动链路和 PM2 拓扑。
- `scripts/postbuild.ts`：sitemap 生成及 standalone 运行时资源复制。
- `.github/workflows/lint-check.yml`：CI 的 Node 版本与必跑检查。

## Runtime/Tooling Preferences

- 使用 Node.js + pnpm，不按 Bun 项目处理。CI 使用 Node 26；仓库当前没有 `engines` 或 `packageManager` 版本锁定，以 lockfile 和 CI 为准。
- `package.json` 为 ESM（`"type": "module"`）；TypeScript 运维脚本通过 `esno` 执行。
- TypeScript 为 strict、ESNext、bundler resolution、`noEmit`；别名 `~/*` 指向仓库根目录。
- Tailwind v4 仅通过 `postcss.config.js` 的 `@tailwindcss/postcss` 接入，没有 `tailwind.config.*`；主题入口使用现有样式文件，不新增旧版配置。
- Prisma 7 使用 PostgreSQL `pg` adapter；schema 根为 `prisma/schema/`，生成目录被忽略。schema 改动至少运行 `pnpm prisma:generate`。
- 改 `prisma/schema` 必须同时新增迁移：`pnpm db:new <slug>` 生成草稿 → 手改（大表上的索引拆到 `.notx.sql` 用 `CONCURRENTLY`；需要新代码先上线的收缩与回填写 `-- phase: post` 并注明回滚影响）→ `pnpm db:snapshot` → `pnpm db:migrate` 应用到本地库。触发器、函数、部分索引和数据修复同样只写成迁移；旧的旁路载体 `prisma/sql/` 与 `migration/ensure*.ts` 已删除，不要再建。CI 的 `db-replay` job 从空库回放并执法：改了 schema 没写迁移、改了迁移没刷新快照都会失败。
- 已合入的迁移文件不可修改（台账记有 checksum），要改就另写一个新迁移；函数或触发器每换一代也是一个新迁移，写完整的 `CREATE OR REPLACE`。派生列（`patch` 的三个计数列与 `released_sort`、`patch_tag.count`、`patch_company.count`）只由触发器维护，应用层不写。
- `pnpm db:new` 与 `pnpm db:snapshot` 需要一个会被清空的回放库，由 `KUN_DB_SCRATCH_URL` 指定，例如 `docker run --rm -d --name kun-db-scratch -p 127.0.0.1:55433:5432 --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=kun postgres:17-alpine` 配 `KUN_DB_SCRATCH_URL=postgresql://postgres:kun@127.0.0.1:55433/postgres`；工具拒绝清空带表的非回放库。
- 迁移台账在独立的 `kun_meta` schema（Prisma 不碰它）。库用户不是库的属主时建不了 schema，首次 `pnpm db:migrate` 会报出要由属主执行一次的 `CREATE SCHEMA kun_meta AUTHORIZATION …` 语句。
- 部署链，编排在 `scripts/deployChain.ts`：`deploy:build` 依次执行 `git pull` → `db:migrate --phase pre` → 构建之前的 `db:verify` → `prisma:generate` → 构建 → 切换 → `db:migrate --phase post` → `db:verify --prisma`。部署链不执行 `prisma db push`，库的结构只由迁移推进，漏写迁移或库被手工改过不会再被悄悄抹平。
- 构建之前的校验分两种。没有待执行的 post 迁移时是全量的 `db:verify --prisma`（台账、INVALID 索引、库级对象、表结构），任何一项不符都在构建之前中止，线上的构建不变。有待执行的 post 迁移时是 `db:verify --phase pre --expand`：post 负责的删列、加约束、触发器要等新代码上线才执行，此刻对不上是正常的，所以只查台账、INVALID 索引，以及 schema 里的表与列库里是否都已存在；其余差异要到切换之后的收尾校验才报出来。因此新表、新列必须写在 pre 迁移里，写进 post 会让部署在构建之前被挡下。
- 部署的退出码：0 是全部通过；1 是切换之前中止（`git pull`、pre 迁移、构建之前的校验、构建、切换本身），线上的构建没有变化；2 是新构建已上线但数据库这边没有收尾（post 迁移失败，或收尾校验不通过），不回滚构建，按输出处理后单独重跑 `pnpm db:migrate --phase post` 与 `pnpm db:verify --prisma`。
- 阶段次序的限制：pre 迁移不能排在尚未执行的 post 迁移之后（那个 post 还没部署，或上次执行失败），部署时 `--phase pre` 会以 `pending-post-before-pre` 拒绝。新代码不依赖它时把它也写成 post，否则等前一个 post 部署并执行完再合入。被拒绝时，只有带那个 post 的版本已经上线才可以补跑 `pnpm db:migrate --phase post`；还没上线就先部署一个不含这个 pre 的版本。
- `deploy:install` 是新环境入口，执行不分阶段的 `db:migrate`。不要在已上线的环境用它更新依赖：它会在新构建上线之前执行 post 迁移，那种情况用 `pnpm install`。
- 已有库首次接入（由 `db push` 建起来，或恢复的备份没带 `kun_meta`）：`db:migrate` 拒绝在「已有表而基线迁移不在台账里」的库上执行。先 `pnpm db:inspect --counts`；prisma diff 扣除白名单后剩余 0 条才可以用 `pnpm db:migrate --mark-applied 0001 --reason <依据>` 登记基线，盘点里对象一致且对账为 0 的其他版本可一并登记，其余交给 `pnpm db:migrate` 执行，最后 `pnpm db:verify --prisma --counts`。登记只记账、不改数据；`released_sort` 的回填（0003）若是实际执行而不是登记，之后要跑 `pnpm search:init && pnpm search:sync-all`。
- 本地用过 `prisma:push` 做原型的改动，落成迁移后用 `pnpm db:migrate --mark-applied <版本> --reason <依据>` 登记，或先撤掉原型改动再 `pnpm db:migrate`。
- `.env` 文件是启动/构建硬性前置，`validations/dotenv-check.ts` 会 fail fast。新增环境变量时同步 schema 与 `.env.example`。
- `pnpm build` 输出 Next standalone；postbuild 还会生成 sitemap，并复制 `public/`、`.next/static/`、`server/image/`、`posts/`、`config/redirect.json`。不要绕过该生命周期部署裸 `.next/standalone`。
- Meilisearch 由 `compose.yaml` 可选启动；运行时必须保留 Prisma fallback。S3、邮件、Cloudflare 等外部服务由环境变量配置，验证时避免真实生产资源。

## Testing & QA

- 测试框架为 Vitest；`vitest.config.ts` 只发现 `**/__tests__/**/*.test.ts`，别把测试放成 `.spec.ts` 或仓库外测试目录。
- 测试与实现同域放置，例如 `server/search/__tests__/filter-builder.test.ts`、`app/api/user/follow/__tests__/route.test.ts`、`app/api/patch/rating/__tests__/write-stat-transaction.test.ts`。
- 现有模式使用 `describe`/`it`/`expect`、`vi.hoisted` + `vi.mock` 隔离 Prisma、Next、认证、缓存、S3 与搜索；fixture 通常内联，`beforeEach` 重置并设置确定性返回值。
- 事务测试应验证可观察结果以及 lock/commit/rollback/retry 顺序；API 测试覆盖成功路径和业务错误字符串，不测试源码文本或实现细节。`server/content` 的命令测试用 `server/db/__tests__/recordingTransaction.ts`：它记录每次尝试的语句（含取锁 SQL）与提交 / 回滚，读取必须先配置，没配就抛错。入口测试要么同样用它端到端跑，要么在命令层 mock。
- Lua 脚本（尝试预算等）的语义由真 Redis 契约测试守护：文件名 `*.redis.test.ts`，只在设了 `KUN_REDIS_CONTRACT_URL` 时运行，默认的 `pnpm test` 里整组跳过，CI 的 `redis-contract` job 执行。本地先起一个一次性容器 `docker run --rm -d --name kun-redis-contract -p 127.0.0.1:56379:6379 redis:8.0-alpine`（与生产同主次版本），再 `KUN_REDIS_CONTRACT_URL=redis://127.0.0.1:56379 pnpm exec vitest run redis.test`。入口 `lib/__tests__/redisContract.ts` 只认回环地址；用例不清库，只读写自己造的键（主体 id 取 int4 之外的随机数）。新增或改写 Lua 必须配这类用例：mock 掉 `~/lib/redis` 的测试证明不了脚本语义。
- 应用层要靠数据库才成立的行为（条件更新在并发下由库重新判定、同一把行锁下的查询、唯一约束与回滚）用真 PostgreSQL 的用例守护：文件名 `*.db.test.ts`，只在设了 `KUN_DB_CONTRACT_URL` 时运行，CI 的 `db-replay` job 在回放完迁移的空库上执行。入口 `server/db/__tests__/dbContract.ts` 只认回环地址，连上之后经应用自己的 prisma 单例核对库名，并要求 `user` 表为空——本机的开发库是生产数据的副本，绝不能指过去。本地用上面那个回放库容器：先 `pnpm db:snapshot --check` 把迁移回放进去，再 `KUN_DB_CONTRACT_URL=postgresql://postgres:kun@127.0.0.1:55433/postgres pnpm exec vitest run server/auth/__tests__/emailChange.db.test.ts`。
- 修改行为后先运行对应文件：`pnpm test -- <path>`，再运行 `pnpm typecheck`。共享服务、事务或 CI 相关变更运行全量 `pnpm test`；路由、Next 配置、Prisma 或 standalone 变更再运行 `pnpm build`。
- CI 在 Node 26 上依次执行复制 `.env.example`（须在安装前，postinstall 的 `prisma generate` 依赖 `KUN_DATABASE_URL`）、安装、`pnpm prisma:generate`、`pnpm lint`、`pnpm typecheck` 和 `pnpm test`。
- 当前没有全局 test setup、快照、浏览器/E2E runner、真实集成数据库 harness 或覆盖率配置；没有数值覆盖率门槛。不要声称覆盖率或端到端验证，除非单独实际执行。

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
