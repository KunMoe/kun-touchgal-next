-- lock_timeout: 5s
-- patch.released_sort: 「发售时间」排序键, 只由本触发器维护, 应用层不写。
-- released 是自由文本 ('YYYY-MM-DD' | 'YYYY-MM' | 'YYYY' | 'unknown' | '' | 'TBA' ...),
-- 按字符串排序时 unknown / TBA 会排进降序首位, 未补零的 2021-8-27 会错位。
-- released_sort 存 YYYYMMDD 整数 (缺月 / 日补 00), 无法解析为 NULL。
-- 触发器只监听 released 与 released_sort 本身: 手工改 released_sort 也会被重算回来;
-- 不监听全部 UPDATE, 免得浏览量回刷每次都执行触发器。
--
-- 回填借触发器重算, 解析表达式只保留函数体里这一份 (scripts/db/lib/derivedColumns.ts
-- 的只读对账有一份逐字副本, 由单测守护)。CREATE TRIGGER 持有的 SHARE ROW EXCLUSIVE
-- 锁到提交才释放, 并发写入要么排在回填之后经触发器计算, 要么已提交并被回填覆盖。
-- 回填会改写 patch 全表, 生产放在低峰执行; 执行后须跑 search:init 与 search:sync-all。

CREATE OR REPLACE FUNCTION patch_released_sort_trg() RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER patch_released_sort_trg
BEFORE INSERT OR UPDATE OF released, released_sort
ON "patch"
FOR EACH ROW EXECUTE FUNCTION patch_released_sort_trg();

UPDATE "patch" SET released = released;
