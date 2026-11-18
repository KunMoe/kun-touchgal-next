-- phase: pre
-- 搜索写出箱的认领令牌 seq 改从全局序列取值 (server/search/sync.ts)。此前新插入的行 seq 是 0、
-- 重复入队时加 1, 消费者按 (patch_id, seq) 删行。续锁失败时两个 drain 会并发: 一个同步完删掉
-- (P, 0), 随后的变更重新插入的行又是 (P, 0), 另一个 drain 若在那次变更提交之前读过补丁, 就按
-- 旧读数把新行删掉, 搜索文档停在旧值直到这个补丁下一次变更。与 0010 给 S3 删除写出箱做的修正
-- 同一回事。新代码在冲突时也显式取 nextval, 令牌全局不重复, 不依赖下一段的求值顺序。
--
-- 列保持 integer, 只加默认值: 部署窗口里仍在线的旧构建照常「新插入取默认值、冲突加 1」。
-- INSERT … ON CONFLICT 在判冲突之前就求默认值, 每次入队都消耗一个序列值 (旧构建的单条入队是
-- Prisma 原生 upsert, 回放库上实测每调一次序列前进 1), 所以加 1 得到的值追不上序列, 删行后
-- 重新插入的行不会撞上旧读数。序列从存量最大值之后起, 不与现有行的 seq 相撞。
-- 序列是 Prisma 默认的 bigint 序列, 列是 integer: 发到 2^31 时插入会报越界, 按入队频率不会发生。
--
-- 为什么是 pre: 新代码的冲突分支调用这个序列; 旧代码看不见它。
-- 回滚影响: 无数据影响。回到旧构建后新插入的行从序列取初值、冲突照旧加 1, 按上一段的道理同样
-- 不会撞上旧读数。

CREATE SEQUENCE search_outbox_seq_seq;

ALTER TABLE "search_outbox" ALTER COLUMN "seq" SET DEFAULT nextval('search_outbox_seq_seq');

ALTER SEQUENCE search_outbox_seq_seq OWNED BY "search_outbox"."seq";

SELECT setval('search_outbox_seq_seq', COALESCE(max("seq"), 0) + 1, false) FROM "search_outbox";
