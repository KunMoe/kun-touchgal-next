import 'dotenv/config'
import { prisma } from '~/prisma/index'

// released 为自由文本 ('YYYY-MM-DD' | 'YYYY-MM' | 'YYYY' | 'unknown' | '' | 'TBA' ...),
// 按字符串排序时 unknown/TBA 会排进降序首位、未补零的 2021-8-27 会错位.
// released_sort 存 YYYYMMDD 整数 (缺省月/日补 00), 无法解析为 NULL, 供「发售时间」排序.
// 正则用 [0-9] 而非 \d: 模板字符串会把 \d 吃成 d
const TRIGGER_STATEMENTS: string[] = [
  `
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
$$ LANGUAGE plpgsql
`,
  // 只监听 released 与 released_sort 本身: 手工改 released_sort 也会被重算回来;
  // 不监听全部 UPDATE, 避免浏览量回刷 (flushPatchViewsTask) 每次都执行触发器.
  // OR REPLACE (PG 14+) 而非 DROP + CREATE: 重跑时 DROP 已存在的触发器会持有
  // ACCESS EXCLUSIVE 至提交, backfill 期间连读都被阻塞
  `
CREATE OR REPLACE TRIGGER patch_released_sort_trg
BEFORE INSERT OR UPDATE OF released, released_sort
ON "patch"
FOR EACH ROW EXECUTE FUNCTION patch_released_sort_trg()
`
]

// 借触发器重算, 解析表达式只保留一份; updated 由 Prisma 应用层维护, 不受影响
const BACKFILL_SQL = 'UPDATE "patch" SET released = released'

// 建议在低峰执行: CREATE TRIGGER 持有的 SHARE ROW EXCLUSIVE 锁会阻塞 patch 写入至事务提交
const main = async () => {
  try {
    console.log('Installing patch released_sort trigger and backfilling...')
    // 装触发器与 backfill 放进单个事务: 锁持有至提交, 并发写入要么排在 backfill 之后
    // 经触发器计算, 要么在装触发器之前已提交并被 backfill 覆盖, 不存在漏算窗口
    await prisma.$transaction(
      async (tx) => {
        for (const stmt of TRIGGER_STATEMENTS) {
          await tx.$executeRawUnsafe(stmt)
        }
        await tx.$executeRawUnsafe(BACKFILL_SQL)
      },
      { timeout: 10 * 60 * 1000 }
    )
    console.log('Trigger installed and released_sort backfilled.')
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

main()
