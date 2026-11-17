-- phase: post
-- 0007 两个部分唯一索引的前置检查: 存量里还有「单独形态」重复时在这里停下, 不去建索引。
-- 为什么是 post: 与 0007 同理, 见那里。回滚影响: 无, 本文件不改任何东西。
-- 有重复时须先人工裁定再重跑 `pnpm db:migrate`: 真重复 → 合并或删除条目;
-- 同一作品的不同版本 → 给其中一条补 vndb_relation_id; 填错 → 改正 vndb_id。
-- 列出重复:
--   SELECT vndb_id, array_agg(id ORDER BY id) FROM patch
--     WHERE vndb_id IS NOT NULL AND vndb_relation_id IS NULL
--     GROUP BY 1 HAVING COUNT(*) > 1;
--   SELECT vndb_relation_id, array_agg(id ORDER BY id) FROM patch
--     WHERE vndb_relation_id IS NOT NULL AND vndb_id IS NULL
--     GROUP BY 1 HAVING COUNT(*) > 1;

DO $$
DECLARE
  solo_vndb_id int;
  solo_relation_id int;
BEGIN
  SELECT COUNT(*) INTO solo_vndb_id FROM (
    SELECT 1 FROM "patch"
    WHERE vndb_id IS NOT NULL AND vndb_relation_id IS NULL
    GROUP BY vndb_id HAVING COUNT(*) > 1
  ) t;
  SELECT COUNT(*) INTO solo_relation_id FROM (
    SELECT 1 FROM "patch"
    WHERE vndb_relation_id IS NOT NULL AND vndb_id IS NULL
    GROUP BY vndb_relation_id HAVING COUNT(*) > 1
  ) t;

  IF solo_vndb_id > 0 OR solo_relation_id > 0 THEN
    RAISE EXCEPTION
      'patch 存量里有单独形态的 vndb 重复: vndb_id % 组, vndb_relation_id % 组',
      solo_vndb_id, solo_relation_id
      USING HINT = '先人工裁定这些条目再重跑, 查询与处置办法见 db/migrations/0006_patch_vndb_solo_precheck.sql 文件头';
  END IF;
END
$$;
