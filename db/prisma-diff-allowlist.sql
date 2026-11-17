-- `prisma migrate diff` (现网 → prisma/schema) 的已知噪音, 逐字列出; `pnpm db:verify --prisma`
-- 把它们扣掉之后必须为空。这里列出的语句若不再出现, 同样判为失败: 噪音消失或变形后
-- 还留着白名单, 就成了漂移检查的盲区。
--
-- patch_released_idx: Prisma 认不出 varchar 列上的 text_pattern_ops 操作符类, 每次比对
-- 都想删掉重建。库里的索引本身是对的, 不要动它, 也不要改 schema 去迁就。

DROP INDEX "patch_released_idx";
CREATE INDEX "patch_released_idx" ON "patch"("released" text_pattern_ops);
