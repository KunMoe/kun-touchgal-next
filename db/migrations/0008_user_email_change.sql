-- phase: pre
-- 自助改邮箱的台账 (server/auth/emailChange.ts): 一行是一次变更, 24 小时冷却与发往旧邮箱的
-- 撤销链接都读它。此前撤销状态是一条按随机 token 寻址的 Redis 记录, 库里没有按用户的变更
-- 状态: 连续改两次邮箱, 发往最初邮箱的撤销链接就命中 0 行而作废。
--
-- 为什么是 pre: 新表, 新代码一上线就读写它; 旧代码不认识这张表, 多出来不影响。
-- 回滚影响: 回到旧构建后这张表没人读写, 可留可删; 新构建期间发出的撤销链接在旧构建下打不开。
-- 三个时间列都由应用以 JS Date 写入 (UTC 墙钟)。created 刻意不设 DEFAULT: 冷却按它判定,
-- 而 CURRENT_TIMESTAMP 写进无时区列的是会话时区的墙钟。

CREATE TABLE "user_email_change" (
    "id" SERIAL NOT NULL,
    "old_email" VARCHAR(1007) NOT NULL,
    "new_email" VARCHAR(1007) NOT NULL,
    "revert_token_hash" CHAR(64) NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "reverted" TIMESTAMP(3),

    CONSTRAINT "user_email_change_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_email_change_revert_token_hash_key" ON "user_email_change"("revert_token_hash");

CREATE INDEX "user_email_change_user_id_created_idx" ON "user_email_change"("user_id", "created");

ALTER TABLE "user_email_change" ADD CONSTRAINT "user_email_change_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
