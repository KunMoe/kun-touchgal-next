-- phase: pre
-- 作者 / 操作者型外键改为 ON DELETE SET NULL (T11 A 片, 语义表见 server/account/userReferences.ts):
-- patch_tag.user_id (建标签的人)、patch_company.user_id (建会社的人)、moderation_blacklist.user_id
-- (添加规则的管理员)、admin_log.user_id (写日志的管理员)。此前四条都是 NOT NULL + CASCADE: 删掉一位
-- 前任编辑, 全站共享的标签与会社被不可逆地删除并从所有游戏上摘掉, 黑名单规则与审计轨迹一起消失
-- (P06-01)。改为断开归属: 记录保留, 列置空, 读点显示「已注销用户」。先例是 patch_report.handler_id。
--
-- 为什么是 pre: 新代码的删号流程 (server/account/deleteAccount.ts) 依赖置空语义, 新代码先于本迁移
-- 上线的话, 那段时间里删号仍会级联删掉标签与会社。旧代码只读写非空值, 不受影响。
-- 锁: 删外键对子表与 user 表都取 ACCESS EXCLUSIVE (PG 17 实测), 持有到提交, 期间 user 表的读写
-- 都排队。四张表都很小 (生产副本 12,886 / 4,791 / 4 / 4,301 行), 在生产副本上回滚事务内实测整段
-- 31 ms。拿不到锁时按 tx 文件的默认 lock_timeout 失败, 部署在切换之前中止, 重跑即可。
-- 部署窗口内不要删用户: 旧构建在本迁移之后
-- 删号, 留下的空作者会让旧构建的标签 / 会社详情页与管理日志页按非空读而报错。
-- 回滚影响: 回到旧构建后, 已被置空的行在旧构建里读作非空 (标签 / 会社详情页、管理日志、审核黑名单
-- 列表会报错), 需要先把这些行的 user_id 指到一个保留账号; 要恢复 NOT NULL + CASCADE 同样得先消除
-- 空值。没有发生过删号就没有空值, 回滚无数据影响。

ALTER TABLE "admin_log" DROP CONSTRAINT "admin_log_user_id_fkey";

ALTER TABLE "moderation_blacklist" DROP CONSTRAINT "moderation_blacklist_user_id_fkey";

ALTER TABLE "patch_company" DROP CONSTRAINT "patch_company_user_id_fkey";

ALTER TABLE "patch_tag" DROP CONSTRAINT "patch_tag_user_id_fkey";

ALTER TABLE "admin_log" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "moderation_blacklist" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "patch_company" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "patch_tag" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "admin_log" ADD CONSTRAINT "admin_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "moderation_blacklist" ADD CONSTRAINT "moderation_blacklist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "patch_company" ADD CONSTRAINT "patch_company_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "patch_tag" ADD CONSTRAINT "patch_tag_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
