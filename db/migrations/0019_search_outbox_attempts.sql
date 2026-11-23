-- phase: pre
-- 搜索写出箱记失败次数与退避 (server/search/sync.ts)。此前 drain 应用失败只打日志、不动这一行:
-- 一份被 Meilisearch 确定性拒绝的文档 (例如简介在代理对中间被截断、请求体带孤立代理) 每分钟重试
-- 一次, 永远排在出箱里。现在被拒一次 attempts 加 1, next_attempt_at 按 2^(n-1) 分钟退避 (封顶
-- 6 小时), 到 10 次后不再取 (隔离), last_error 记最近一次的原因; 引擎整体不可用 (连不上、超时、
-- 5xx、密钥不对) 不计次数。应用写入的入队把三列复位, 对账的入队不复位。
--
-- 为什么是 pre: 新代码一上线 drain 就按这三列取行、写失败记录; 旧代码不认识它们, 多出来不影响
-- (旧代码的入队照旧只换发 seq, 不复位, 旧 drain 不看 attempts, 照旧每轮重试全部行)。
-- 锁: 带常量默认值与可空的 ADD COLUMN 只改元数据, 不重写表、不需要回填; 对 search_outbox 取
-- ACCESS EXCLUSIVE, 持有到提交。这张表平时只有待同步的几行, 但每次写补丁都会入队: 拿不到锁时
-- 按 tx 文件的默认 lock_timeout 失败, 部署在切换之前中止, 重跑即可。
-- 回滚影响: 无数据影响, 但回滚到的那个提交必须保留本文件与 prisma/schema/search.prisma 里的这三列
-- (只回退代码): 去掉本文件, 部署会因台账里的 0019 找不到文件而中止; 去掉 schema 里的三列, 构建
-- 之前的校验会报库里多出三列。回到旧代码后三列没人读写, 已隔离的行重新被旧 drain 每轮重试;
-- 再升回来时它们仍带着回滚前的失败次数。

ALTER TABLE "search_outbox" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_error" VARCHAR(1007),
ADD COLUMN     "next_attempt_at" TIMESTAMP(3);
