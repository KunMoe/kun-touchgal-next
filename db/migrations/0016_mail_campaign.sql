-- phase: pre
-- 群发邮件的任务实体 (server/mail/campaign.ts): 一行是一次群发, 记收件范围的快照
-- (max_user_id)、沿主键推进的游标 (cursor_user_id) 与成功 / 失败计数。此前群发是一次
-- 请求里发完全站的循环, 进度只在那个请求的栈上: 源站 100 秒不出响应时边缘先回 524, 页面上
-- 的发送按钮重新可点, 再点就是从头全站重发; 部署杀掉进程则停在半截、没有记录也没有续发点。
-- 现在由 cron 进程每分钟按游标推进。
--
-- 为什么是 pre: 新表, 新代码一上线就读写它; 旧代码不认识这张表, 多出来不影响。
-- 没有部分唯一索引: 「同一时刻至多一条进行中的任务」由创建时的通告锁 (481005, 0) 保证。
-- site_origin 记发起任务的站点地址, 发信的进程只推进自己这个地址上发起的任务: 这张表会随
-- 数据库的副本去到开发 / 测试环境, 一条 sending 的任务不能在那里接着给真实用户发信。
-- 锁: 新表本身不涉及存量数据。外键的 ADD CONSTRAINT 对被引用的 user 表取 SHARE ROW
-- EXCLUSIVE (挡写不挡读), 新表为空, 校验是瞬时的; 拿不到锁时按 tx 文件的默认 lock_timeout
-- 失败, 部署在切换之前中止, 重跑即可。
-- 回滚影响: 无数据影响, 但只能回退代码, 回滚到的那个提交必须保留本文件、
-- prisma/schema/mail.prisma、prisma/schema/user.prisma 里的反向关系 (mail_campaign
-- mail_campaign[]) 与 server/account/userReferences.ts 里对应的登记: 去掉本文件, 部署会因
-- 台账里的 0016 找不到文件而中止; 去掉模型, 构建之前的校验会报库里多出一张表; 只去掉反向
-- 关系, prisma 报关系缺一侧。回到旧代码后这张表没人读写: 当时还在进行中的任务停在原地,
-- 再升回来时会从游标处接着发 —— 不想续发就先把它的 status 改成 cancelled。新代码期间发出
-- 的邮件里的退订链接 (?u=&t=) 在旧代码下打不开, 旧代码只认邮箱加验证码的那一种。

CREATE TABLE "mail_campaign" (
    "id" SERIAL NOT NULL,
    "template_id" VARCHAR(64) NOT NULL,
    "title" VARCHAR(233) NOT NULL,
    "content_html" VARCHAR(100007) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'sending',
    "site_origin" VARCHAR(233) NOT NULL,
    "max_user_id" INTEGER NOT NULL,
    "cursor_user_id" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(1007) NOT NULL DEFAULT '',
    "created_by" INTEGER,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3) NOT NULL,
    "finished" TIMESTAMP(3),

    CONSTRAINT "mail_campaign_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mail_campaign_status_idx" ON "mail_campaign"("status");

CREATE INDEX "mail_campaign_created_by_idx" ON "mail_campaign"("created_by");

ALTER TABLE "mail_campaign" ADD CONSTRAINT "mail_campaign_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
