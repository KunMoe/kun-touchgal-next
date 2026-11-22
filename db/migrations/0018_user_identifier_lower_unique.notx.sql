-- phase: post
-- 用户名与邮箱「只差大小写」的唯一性兜底。
--
-- 为什么是 post: 与 0017 同理, 见那里。回滚影响: 无数据影响。回到更早的构建照常工作: 注册
-- 与改名的预检一直是大小写不敏感的, 撞上这两个索引抛的 P2002 由同一个 catch 接住。
--
-- user 表的 @unique(name) / @unique(email) 是大小写敏感的 btree, 而注册
-- (app/api/auth/register/route.ts) 与改名 (app/api/user/setting/username/route.ts) 的查重
-- 是 insensitiveEquals (server/identity/lookup.ts) 编译出的 ILIKE: Kun 与 kun 并发注册或
-- 改名时双双通过预检, 唯一索引又只认完全同名, 两笔都写得进去。这两个表达式唯一索引兜住
-- 预检与写入之间的并发窗口: 后到的一笔撞上 23505, adapter-pg 映射成 P2002, 上面两个路由
-- 已有的 catch 把它翻成与预检相同的文案。其余写 name / email 的入口撞上时同样得到 P2002
-- (没有逐站点文案的由 kunRoute 回通用文案), 不再写出大小写重复。原有的 @unique 保留:
-- schema 与 findUnique 都依赖它们。
-- lower() 按库的默认排序规则做大小写映射; UTF8 库上 ILIKE 的实现就是两侧先 lower() 再做
-- LIKE, 所以转义过通配符的预检与这两个索引判同一组「同名」, 由
-- server/identity/__tests__/userIdentifier.db.test.ts 在真库上逐个探针核对。
-- 表达式索引无法在 Prisma schema 里声明, Prisma 的差异比对与 db push 也都不碰它们,
-- 所以它们记在 db/objects.snapshot.sql 里, 由 `pnpm db:verify` 核对。
-- 锁: CONCURRENTLY 对 user 表只取 SHARE UPDATE EXCLUSIVE, 不挡读写, 但要等建索引开始时
-- 在途的事务结束。被打断 (进程被杀、连接断开) 留下的 INVALID 索引由执行器在重跑时先删后建。
-- 建索引时报 23505 "Key (lower(name::text))=(...) is duplicated": 0017 通过之后又有
-- 大小写重复从并发窗口里写了进来 (多见于本文件上次被打断、隔了一段时间才重跑)。0017 已在
-- 台账里不会重跑, 按它文件头的查询列出重复、裁定后重跑 `pnpm db:migrate --phase post` 即可;
-- 这次失败留下的 INVALID 索引执行器已当场删掉。

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS user_name_lower_key
  ON "user" (lower(name));

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS user_email_lower_key
  ON "user" (lower(email));
