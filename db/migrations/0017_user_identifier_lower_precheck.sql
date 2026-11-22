-- phase: post
-- 0018 两个表达式唯一索引 (lower(name) / lower(email)) 的前置检查: 存量里还有只差大小写的
-- 用户名或邮箱时在这里停下, 不去建索引。
-- 为什么是 post: 应用代码不依赖这两个索引 —— 注册与改名的大小写不敏感预检照旧在, 撞上
-- 唯一索引的 P2002 也早有 catch 翻成业务文案; 索引只兜预检与写入之间的并发窗口。写成 pre
-- 的话, 生产上只要有一组存量重复, 部署就在切换之前中止 (退出码 1), 同一版里的登录修复
-- 也跟着发不出去; 写成 post, 重复只挡住建索引 (退出码 2, 新构建已经上线)。
-- 回滚影响: 无, 本文件不改任何东西。
-- 它没通过时 0017 / 0018 都留在待执行: 之后再合入的 pre 迁移会被 pending-post-before-pre
-- 挡住, 所以要尽快裁定。
-- 有重复时须先人工裁定再重跑 `pnpm db:migrate --phase post` 与 `pnpm db:verify --prisma`:
-- 用户名 → 经后台的用户编辑给其中一方改名 (那条路径同时作废该账号的旧会话, 不要直接写
-- SQL); 邮箱 → 先确认是不是同一个人的重复注册, 再同样经后台改掉其中一方。
-- 先例: 邮箱的大小写重复清理过一次 (68fccda6 的一次性脚本 migration/fixDuplicateUser.mjs,
-- 后来已删): 按 toLowerCase() 分组, 每组保留萌萌点最多 (相同则注册最早) 的账号, 其余账号
-- 的邮箱重置成随机的 <hex>@example.com。那是 JS 的 toLowerCase(), 这里分组用的是库里的
-- lower(), 只含 ASCII 的地址两者一致; 以下面的查询为准。
-- 列出重复:
--   SELECT lower(name), array_agg(id ORDER BY id) FROM "user"
--     GROUP BY 1 HAVING count(*) > 1;
--   SELECT lower(email), array_agg(id ORDER BY id) FROM "user"
--     GROUP BY 1 HAVING count(*) > 1;

DO $$
DECLARE
  name_groups int;
  email_groups int;
BEGIN
  SELECT COUNT(*) INTO name_groups FROM (
    SELECT 1 FROM "user" GROUP BY lower(name) HAVING COUNT(*) > 1
  ) t;
  SELECT COUNT(*) INTO email_groups FROM (
    SELECT 1 FROM "user" GROUP BY lower(email) HAVING COUNT(*) > 1
  ) t;

  IF name_groups > 0 OR email_groups > 0 THEN
    RAISE EXCEPTION
      'user 存量里有只差大小写的重复: 用户名 % 组, 邮箱 % 组',
      name_groups, email_groups
      USING HINT = '先人工裁定这些账号再重跑, 查询与处置办法见 db/migrations/0017_user_identifier_lower_precheck.sql 文件头';
  END IF;
END
$$;
