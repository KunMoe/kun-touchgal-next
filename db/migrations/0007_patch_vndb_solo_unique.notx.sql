-- phase: post
-- 单独 vndb_id / 单独 vndb_relation_id 形态的唯一性兜底。
--
-- 为什么是 post: 必须晚于带应用层预检的代码 (76911f6a) 上线。预检负责挡住新增重复并
-- 给出可读的提示, 索引只兜并发窗口; 没有预检的旧代码撞上索引只会得到一个笼统的冲突。
-- 回滚影响: 无数据影响。回到没有预检的构建时, 重复提交会报唯一约束冲突。
--
-- patch 表只有 @@unique([vndb_id, vndb_relation_id]) 组合唯一索引, 而唯一索引默认
-- NULLS DISTINCT: 任意一列为 NULL 的行不参与冲突, (v123, NULL) 与 (NULL, r456) 形态
-- 可以无限重复。应用层预检 (app/api/edit 的 create.ts / update.ts) 已挡住同形态重复,
-- 这两个部分唯一索引兜住预检与写入之间的并发窗口 (违反时抛 P2002, 与组合索引同一个 catch)。
-- 只约束「另一半为 NULL」的行: 同 vndb_id 不同 relation 的共存 (同一作品的不同 release)
-- 不受影响, (NULL, NULL) 行不受任何约束。
-- 部分索引无法在 Prisma schema 里声明, Prisma 的差异比对也完全忽略它们,
-- 所以它们记在 db/objects.snapshot.sql 里, 由 `pnpm db:verify` 核对。
-- 建索引时报 23505 "Key (vndb_id)=(...) is duplicated": 0006 通过之后又有重复写了进来。
-- 0006 已在台账里不会重跑, 按它文件头的查询列出重复、裁定后重跑本命令即可。

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS patch_vndb_id_solo_key
  ON patch (vndb_id) WHERE vndb_relation_id IS NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS patch_vndb_relation_id_solo_key
  ON patch (vndb_relation_id) WHERE vndb_id IS NULL;
