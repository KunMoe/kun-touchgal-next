-- phase: pre
-- 审核任务的失败记账拆成两份预算 (server/moderation/accounting.ts): retry 只扣这条内容自己的
-- 失败 (输出不合约定、落库被拒), 依赖类失败 (供应商不可用、限流、凭据或地址不对) 另记在
-- defer_count 里。此前只有 retry 一份: 供应商宕机期间每条送审都白跑三次后转人工, 内容持续隐藏,
-- 恢复只能靠管理员逐页重排。failure_kind 记最近一次失败的类别, 供管理端区分转人工的原因。
-- 不复用 reject_code: 那一列在 AI 拿不准转人工的任务上存的是 AI 的类别码 (apply.ts)。
--
-- 为什么是 pre: 新代码一上线 worker 就读写这两列; 旧代码不认识它们, 多出来不影响。
-- 锁: 带常量默认值的 ADD COLUMN 只改元数据, 不重写表、不需要回填; 对 moderation_task 取
-- ACCESS EXCLUSIVE, 持有到提交。拿不到锁时按 tx 文件的默认 lock_timeout 失败, 部署在切换之前
-- 中止, 重跑即可。
-- 回滚影响: 无数据影响, 但回滚到的那个提交必须保留本文件与 prisma/schema 里的这两列 (只回退
-- 代码): 去掉本文件, 部署会因台账里的 0015 找不到文件而中止; 去掉 schema 里的两列, 构建之前
-- 的校验会报库里多出两列。回到旧代码后这两列没人读写, 已推迟过的任务照旧按 retry 处理; 旧代码
-- 落定或重排的任务不清 failure_kind, 再升回来时这些行会带着过时的失败类别 (只影响管理端展示)。

ALTER TABLE "moderation_task" ADD COLUMN     "defer_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failure_kind" VARCHAR(32) NOT NULL DEFAULT '';
