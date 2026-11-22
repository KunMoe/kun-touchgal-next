-- 生成物, 不要手改。由 `pnpm db:snapshot` 从空库按序回放 db/migrations 后导出,
-- 只含 Prisma schema 看不见的库级对象: 函数、触发器、部分索引与表达式索引、CHECK 约束。
-- 表、列与普通索引由 `pnpm db:verify --prisma` 对照 prisma/schema 比对。
-- `pnpm db:verify` 拿各环境的实际对象与本文件逐个比对, 它也是所装对象的版本标识。

-- function: patch_comment_count_trg()
CREATE OR REPLACE FUNCTION public.patch_comment_count_trg()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- function: patch_company_count_trg_del()
CREATE OR REPLACE FUNCTION public.patch_company_count_trg_del()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- function: patch_company_count_trg_ins()
CREATE OR REPLACE FUNCTION public.patch_company_count_trg_ins()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- function: patch_company_count_trg_upd()
CREATE OR REPLACE FUNCTION public.patch_company_count_trg_upd()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- function: patch_favorite_count_trg()
CREATE OR REPLACE FUNCTION public.patch_favorite_count_trg()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- function: patch_released_sort_trg()
CREATE OR REPLACE FUNCTION public.patch_released_sort_trg()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.released ~ '^[0-9]{4}(-[0-9]{1,2}(-[0-9]{1,2})?)?$' THEN
    NEW.released_sort :=
      split_part(NEW.released, '-', 1)::int * 10000
      + COALESCE(NULLIF(split_part(NEW.released, '-', 2), '')::int, 0) * 100
      + COALESCE(NULLIF(split_part(NEW.released, '-', 3), '')::int, 0);
  ELSE
    NEW.released_sort := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

-- function: patch_resource_count_trg()
CREATE OR REPLACE FUNCTION public.patch_resource_count_trg()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- function: patch_tag_count_trg_del()
CREATE OR REPLACE FUNCTION public.patch_tag_count_trg_del()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- function: patch_tag_count_trg_ins()
CREATE OR REPLACE FUNCTION public.patch_tag_count_trg_ins()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- function: patch_tag_count_trg_upd()
CREATE OR REPLACE FUNCTION public.patch_tag_count_trg_upd()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;

-- trigger: patch.patch_released_sort_trg
CREATE TRIGGER patch_released_sort_trg BEFORE INSERT OR UPDATE OF released, released_sort ON public.patch FOR EACH ROW EXECUTE FUNCTION public.patch_released_sort_trg();

-- trigger: patch_comment.patch_comment_count_trg
CREATE TRIGGER patch_comment_count_trg AFTER INSERT OR DELETE OR UPDATE OF patch_id, status ON public.patch_comment FOR EACH ROW EXECUTE FUNCTION public.patch_comment_count_trg();

-- trigger: patch_company_relation.patch_company_count_trg_del
CREATE TRIGGER patch_company_count_trg_del AFTER DELETE ON public.patch_company_relation REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.patch_company_count_trg_del();

-- trigger: patch_company_relation.patch_company_count_trg_ins
CREATE TRIGGER patch_company_count_trg_ins AFTER INSERT ON public.patch_company_relation REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.patch_company_count_trg_ins();

-- trigger: patch_company_relation.patch_company_count_trg_upd
CREATE TRIGGER patch_company_count_trg_upd AFTER UPDATE ON public.patch_company_relation REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.patch_company_count_trg_upd();

-- trigger: patch_resource.patch_resource_count_trg
CREATE TRIGGER patch_resource_count_trg AFTER INSERT OR DELETE OR UPDATE OF patch_id, status ON public.patch_resource FOR EACH ROW EXECUTE FUNCTION public.patch_resource_count_trg();

-- trigger: patch_tag_relation.patch_tag_count_trg_del
CREATE TRIGGER patch_tag_count_trg_del AFTER DELETE ON public.patch_tag_relation REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.patch_tag_count_trg_del();

-- trigger: patch_tag_relation.patch_tag_count_trg_ins
CREATE TRIGGER patch_tag_count_trg_ins AFTER INSERT ON public.patch_tag_relation REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.patch_tag_count_trg_ins();

-- trigger: patch_tag_relation.patch_tag_count_trg_upd
CREATE TRIGGER patch_tag_count_trg_upd AFTER UPDATE ON public.patch_tag_relation REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.patch_tag_count_trg_upd();

-- trigger: user_patch_favorite_folder_relation.patch_favorite_count_trg
CREATE TRIGGER patch_favorite_count_trg AFTER INSERT OR DELETE OR UPDATE OF patch_id ON public.user_patch_favorite_folder_relation FOR EACH ROW EXECUTE FUNCTION public.patch_favorite_count_trg();

-- index: patch_vndb_id_solo_key
CREATE UNIQUE INDEX patch_vndb_id_solo_key ON public.patch USING btree (vndb_id) WHERE (vndb_relation_id IS NULL);

-- index: patch_vndb_relation_id_solo_key
CREATE UNIQUE INDEX patch_vndb_relation_id_solo_key ON public.patch USING btree (vndb_relation_id) WHERE (vndb_id IS NULL);

-- index: user_email_lower_key
CREATE UNIQUE INDEX user_email_lower_key ON public."user" USING btree (lower((email)::text));

-- index: user_name_lower_key
CREATE UNIQUE INDEX user_name_lower_key ON public."user" USING btree (lower((name)::text));
