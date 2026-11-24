-- phase: pre
-- S3 删除写出箱的行带上「最早可以处理的时刻」(server/storage/s3Outbox.ts)。封面改成每次替换写一个
-- 新的版本目录之后 (server/storage/patchBanner.ts), 被换下来的旧版本不能立刻删: 共享读缓存与已经打开
-- 的页面里还拿着旧地址, 要等宽限期 (IMAGE_VERSION_DELETION_GRACE_MS, 24 小时) 过了再删。NULL 即立即,
-- 原有的入队全部不传, 语义不变; drain 只取 NULL 或已到时刻的行; 同一 key 重复入队取更早的时刻, NULL 优先。
--
-- 为什么是 pre: 新代码的 drain 一上线就按这一列取行, 替换封面时就会写它; 旧代码不认识它, 多出来不影响。
-- 不设默认值: 存量行与旧代码的入队都是 NULL, 正是「立即」。时刻按 UTC 墙钟写 (与全库无时区的 timestamp
-- 列一致), 原生 SQL 里用 now() AT TIME ZONE 'UTC'。
-- 锁: 可空、无默认值的 ADD COLUMN 只改元数据, 不重写表、不需要回填; 对 s3_deletion_outbox 取
-- ACCESS EXCLUSIVE, 持有到提交。这张表平时只有几行, 但删资源、删游戏都会入队: 拿不到锁时按 tx 文件的
-- 默认 lock_timeout 失败, 部署在切换之前中止, 重跑即可。
-- 回滚影响: 回滚到的那个提交必须保留本文件与 prisma/schema/storage.prisma 里的这一列 (只回退代码):
-- 去掉本文件, 部署会因台账里的 0021 找不到文件而中止; 去掉 schema 里的列, 构建之前的校验会报库里多出
-- 一列。回到旧代码后旧 drain 不看这一列, 还在宽限期里的旧封面版本会被立即删掉: 缓存里还拿着旧地址的
-- 页面 (最多 300 秒) 会显示裂图, 列表卡片有回落图, 详情页的主图没有。

ALTER TABLE "s3_deletion_outbox" ADD COLUMN     "not_before" TIMESTAMP(3);
