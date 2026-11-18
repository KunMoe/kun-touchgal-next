-- phase: pre
-- patch_resource_link.s3_key 的普通索引, 给 S3 删除写出箱消费者的引用点查
-- (server/storage/references.ts) 用。今天的谓词还带着「s3_key 为空的历史行按 content 尾段
-- 匹配」的分支, 用不上这个索引; 等 migration/backfillResourceLinkS3Key.ts 把历史行回填完、
-- 报告剩余 0 行之后, 谓词收窄为 s3_key = key, 才走这个索引。
-- 不建唯一索引: 历史共享对象回填之后几行共用一个 s3_key。不建部分索引: 普通索引能在
-- Prisma schema 里声明, 参数化的等值查询也不依赖计划能否匹配部分谓词。
--
-- 为什么是 pre: 新代码不依赖它, 先建好不影响任何构建; 写成 post 会挡住之后的 pre 迁移。
-- 本机的生产数据副本约 4.2 万行, 并发建索引在秒级。

CREATE INDEX CONCURRENTLY IF NOT EXISTS "patch_resource_link_s3_key_idx" ON "patch_resource_link"("s3_key");
