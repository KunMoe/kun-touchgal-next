-- phase: post
-- lock_timeout: 5s
-- patch_tag.count / patch_company.count 的语句级计数触发器。
--
-- 为什么是 post: 必须晚于「拆除应用层手工计数」的代码 (465f5db9) 上线。窗口期的漏计
-- 由本文件的回填一并修正; 顺序颠倒则窗口期双计。
-- 回滚影响: 执行之后不能回到 465f5db9 之前的构建, 否则应用层与触发器同时计数。
--
-- 语句级 + transition table: 级联删除的每条内部 DELETE 同样触发, 删除侧不漏减;
-- ON CONFLICT 未实插的行不进 transition 表, 并发重复递增的口子一并关闭。
-- 不用行级触发器: 行级版的父表行锁顺序等于调用方数组顺序, 各 createMany 调用点顺序
-- 互不一致, 并发反序插入即死锁。函数内必须 FOR 循环按 id 升序逐行点查更新 ——
-- ORDER BY + FOR UPDATE 的加锁顺序由执行计划决定, 不保证有序; 也不得显式 FOR UPDATE:
-- 它与并发 INSERT 经外键检查对父行持有的 FOR KEY SHARE 冲突, UPDATE count 自带的
-- FOR NO KEY UPDATE 才相容。引用 transition 表的触发器不能挂 INSERT OR DELETE 合体,
-- 也不能带列列表 (UPDATE OF), 所以按事件拆成三个, upd 在函数内用 IS DISTINCT FROM 过滤。
--
-- 四条 DROP ... IF EXISTS 摘掉 2026-08-06 之前的行级代 (触发器与函数同名, 不带
-- _ins/_del/_upd 后缀): 不摘的话新旧两代并存, 计数翻倍。旧对象不存在时不取锁;
-- 存在时 DROP TRIGGER 取 ACCESS EXCLUSIVE 并持有到提交, 期间两张关系表连读都被阻塞
-- (DROP 放在最前是为了不在持有其他锁之后再升级, 那样会与读后写的业务事务死锁)。
-- 装触发器、加锁、回填同一个事务, 先装后填, 理由同 0002。生产放在低峰执行。
-- 这两个 count 不在搜索文档里, 执行后不需要重建搜索索引。

DROP TRIGGER IF EXISTS patch_tag_count_trg ON "patch_tag_relation";

DROP FUNCTION IF EXISTS patch_tag_count_trg();

CREATE OR REPLACE FUNCTION patch_tag_count_trg_ins() RETURNS trigger AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tag_id AS fk, COUNT(*)::int AS c
    FROM new_rows GROUP BY tag_id ORDER BY tag_id
  LOOP
    UPDATE "patch_tag" SET count = count + r.c WHERE id = r.fk;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION patch_tag_count_trg_del() RETURNS trigger AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tag_id AS fk, COUNT(*)::int AS c
    FROM old_rows GROUP BY tag_id ORDER BY tag_id
  LOOP
    UPDATE "patch_tag" SET count = GREATEST(count - r.c, 0) WHERE id = r.fk;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION patch_tag_count_trg_upd() RETURNS trigger AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT fk, SUM(delta)::int AS c
    FROM (
      SELECT o.tag_id AS fk, -1 AS delta
      FROM old_rows o JOIN new_rows n USING (id)
      WHERE o.tag_id IS DISTINCT FROM n.tag_id
      UNION ALL
      SELECT n.tag_id, 1
      FROM old_rows o JOIN new_rows n USING (id)
      WHERE o.tag_id IS DISTINCT FROM n.tag_id
    ) s
    GROUP BY fk ORDER BY fk
  LOOP
    UPDATE "patch_tag" SET count = GREATEST(count + r.c, 0) WHERE id = r.fk;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER patch_tag_count_trg_ins
AFTER INSERT ON "patch_tag_relation"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION patch_tag_count_trg_ins();

CREATE OR REPLACE TRIGGER patch_tag_count_trg_del
AFTER DELETE ON "patch_tag_relation"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION patch_tag_count_trg_del();

CREATE OR REPLACE TRIGGER patch_tag_count_trg_upd
AFTER UPDATE ON "patch_tag_relation"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION patch_tag_count_trg_upd();

DROP TRIGGER IF EXISTS patch_company_count_trg ON "patch_company_relation";

DROP FUNCTION IF EXISTS patch_company_count_trg();

CREATE OR REPLACE FUNCTION patch_company_count_trg_ins() RETURNS trigger AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT company_id AS fk, COUNT(*)::int AS c
    FROM new_rows GROUP BY company_id ORDER BY company_id
  LOOP
    UPDATE "patch_company" SET count = count + r.c WHERE id = r.fk;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION patch_company_count_trg_del() RETURNS trigger AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT company_id AS fk, COUNT(*)::int AS c
    FROM old_rows GROUP BY company_id ORDER BY company_id
  LOOP
    UPDATE "patch_company" SET count = GREATEST(count - r.c, 0) WHERE id = r.fk;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION patch_company_count_trg_upd() RETURNS trigger AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT fk, SUM(delta)::int AS c
    FROM (
      SELECT o.company_id AS fk, -1 AS delta
      FROM old_rows o JOIN new_rows n USING (id)
      WHERE o.company_id IS DISTINCT FROM n.company_id
      UNION ALL
      SELECT n.company_id, 1
      FROM old_rows o JOIN new_rows n USING (id)
      WHERE o.company_id IS DISTINCT FROM n.company_id
    ) s
    GROUP BY fk ORDER BY fk
  LOOP
    UPDATE "patch_company" SET count = GREATEST(count + r.c, 0) WHERE id = r.fk;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER patch_company_count_trg_ins
AFTER INSERT ON "patch_company_relation"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION patch_company_count_trg_ins();

CREATE OR REPLACE TRIGGER patch_company_count_trg_del
AFTER DELETE ON "patch_company_relation"
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION patch_company_count_trg_del();

CREATE OR REPLACE TRIGGER patch_company_count_trg_upd
AFTER UPDATE ON "patch_company_relation"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION patch_company_count_trg_upd();

LOCK TABLE "patch_tag_relation", "patch_company_relation" IN SHARE MODE;

UPDATE "patch_tag" p
SET count = COALESCE(r.c, 0)
FROM (SELECT id FROM "patch_tag") base
LEFT JOIN (
  SELECT tag_id, COUNT(*)::int AS c
  FROM "patch_tag_relation"
  GROUP BY tag_id
) r ON r.tag_id = base.id
WHERE p.id = base.id
  AND p.count IS DISTINCT FROM COALESCE(r.c, 0);

UPDATE "patch_company" p
SET count = COALESCE(r.c, 0)
FROM (SELECT id FROM "patch_company") base
LEFT JOIN (
  SELECT company_id, COUNT(*)::int AS c
  FROM "patch_company_relation"
  GROUP BY company_id
) r ON r.company_id = base.id
WHERE p.id = base.id
  AND p.count IS DISTINCT FROM COALESCE(r.c, 0);
