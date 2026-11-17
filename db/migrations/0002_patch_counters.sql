-- lock_timeout: 5s
-- patch.favorite_count / resource_count / comment_count 的行级计数触发器。
-- 这三列没有任何应用层写入方, 卡片与详情页直接读它们。
-- resource_count / comment_count 只统计 status = 0 (正常) 的行: 待审核与隐藏内容不计入
-- 公开计数; comment_count 另排除资源评论 (resource_id 非空); 收藏关系没有 status, 全量计数。
-- 触发器只监听 patch_id / status, 所以过滤列 resource_id 必须不可变。
--
-- 装触发器、加锁、回填必须在同一个事务里, 且先装后填: 并发写入被挡在锁外,
-- 绝对重算的回填才不会覆盖触发器刚加上的 +1。回填只改不一致的行, 在已装好的库上
-- 重跑几乎不写入。
-- 从第一条 CREATE TRIGGER 起到提交, 三张内容表的写入都被阻塞 (聚合扫描期间也是),
-- 生产放在低峰执行。lock_timeout 管的是每一次等锁, 不是整体停顿: 遇上长事务时
-- 最坏要等满三轮重试。

CREATE OR REPLACE FUNCTION patch_favorite_count_trg() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "patch" SET favorite_count = favorite_count + 1 WHERE id = NEW.patch_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "patch" SET favorite_count = GREATEST(favorite_count - 1, 0) WHERE id = OLD.patch_id;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' AND NEW.patch_id IS DISTINCT FROM OLD.patch_id THEN
    UPDATE "patch" SET favorite_count = GREATEST(favorite_count - 1, 0) WHERE id = OLD.patch_id;
    UPDATE "patch" SET favorite_count = favorite_count + 1 WHERE id = NEW.patch_id;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER patch_favorite_count_trg
AFTER INSERT OR DELETE OR UPDATE OF patch_id
ON "user_patch_favorite_folder_relation"
FOR EACH ROW EXECUTE FUNCTION patch_favorite_count_trg();

CREATE OR REPLACE FUNCTION patch_resource_count_trg() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 0 THEN
      UPDATE "patch" SET resource_count = resource_count + 1 WHERE id = NEW.patch_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 0 THEN
      UPDATE "patch" SET resource_count = GREATEST(resource_count - 1, 0) WHERE id = OLD.patch_id;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.patch_id IS DISTINCT FROM OLD.patch_id THEN
      IF OLD.status = 0 THEN
        UPDATE "patch" SET resource_count = GREATEST(resource_count - 1, 0) WHERE id = OLD.patch_id;
      END IF;
      IF NEW.status = 0 THEN
        UPDATE "patch" SET resource_count = resource_count + 1 WHERE id = NEW.patch_id;
      END IF;
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 0 AND NEW.status <> 0 THEN
        UPDATE "patch" SET resource_count = GREATEST(resource_count - 1, 0) WHERE id = NEW.patch_id;
      ELSIF OLD.status <> 0 AND NEW.status = 0 THEN
        UPDATE "patch" SET resource_count = resource_count + 1 WHERE id = NEW.patch_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER patch_resource_count_trg
AFTER INSERT OR DELETE OR UPDATE OF patch_id, status
ON "patch_resource"
FOR EACH ROW EXECUTE FUNCTION patch_resource_count_trg();

CREATE OR REPLACE FUNCTION patch_comment_count_trg() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 0 AND NEW.resource_id IS NULL THEN
      UPDATE "patch" SET comment_count = comment_count + 1 WHERE id = NEW.patch_id;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.status = 0 AND OLD.resource_id IS NULL THEN
      UPDATE "patch" SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = OLD.patch_id;
    END IF;
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.patch_id IS DISTINCT FROM OLD.patch_id THEN
      IF OLD.status = 0 AND OLD.resource_id IS NULL THEN
        UPDATE "patch" SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = OLD.patch_id;
      END IF;
      IF NEW.status = 0 AND NEW.resource_id IS NULL THEN
        UPDATE "patch" SET comment_count = comment_count + 1 WHERE id = NEW.patch_id;
      END IF;
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 0 AND NEW.status <> 0 AND NEW.resource_id IS NULL THEN
        UPDATE "patch" SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = NEW.patch_id;
      ELSIF OLD.status <> 0 AND NEW.status = 0 AND NEW.resource_id IS NULL THEN
        UPDATE "patch" SET comment_count = comment_count + 1 WHERE id = NEW.patch_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER patch_comment_count_trg
AFTER INSERT OR DELETE OR UPDATE OF patch_id, status
ON "patch_comment"
FOR EACH ROW EXECUTE FUNCTION patch_comment_count_trg();

LOCK TABLE "patch_comment", "patch_resource", "user_patch_favorite_folder_relation" IN SHARE MODE;

UPDATE "patch" p
SET
  favorite_count = COALESCE(f.c, 0),
  resource_count = COALESCE(r.c, 0),
  comment_count  = COALESCE(c.c, 0)
FROM (SELECT id FROM "patch") base
LEFT JOIN (
  SELECT patch_id, COUNT(*)::int AS c
  FROM "user_patch_favorite_folder_relation"
  GROUP BY patch_id
) f ON f.patch_id = base.id
LEFT JOIN (
  SELECT patch_id, COUNT(*)::int AS c
  FROM "patch_resource"
  WHERE status = 0
  GROUP BY patch_id
) r ON r.patch_id = base.id
LEFT JOIN (
  SELECT patch_id, COUNT(*)::int AS c
  FROM "patch_comment"
  WHERE status = 0 AND resource_id IS NULL
  GROUP BY patch_id
) c ON c.patch_id = base.id
WHERE p.id = base.id
  AND (
    p.favorite_count IS DISTINCT FROM COALESCE(f.c, 0)
    OR p.resource_count IS DISTINCT FROM COALESCE(r.c, 0)
    OR p.comment_count IS DISTINCT FROM COALESCE(c.c, 0)
  );
