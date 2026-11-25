import { COMMENT_STATUS, RESOURCE_STATUS } from '~/constants/contentStatus'
// 6 个派生列的只读对账: 每条查询返回「列值与实算值不一致」的行数, 期望全为 0。
// 这些列没有任何应用层写入方, 只由 db/migrations 里的触发器维护。
// 只读: 发现不一致时不要拿这些表达式直接 UPDATE —— READ COMMITTED 下无锁的绝对重算
// 会把触发器刚加上的 +1 覆盖回去; 修正只能写成新的迁移, 在 SHARE 锁下回填
export const KUN_DERIVED_COLUMN_CHECKS: { column: string; sql: string }[] = [
  {
    column: 'patch.favorite_count',
    sql: `
SELECT COUNT(*)::int AS mismatched
FROM "patch" p
LEFT JOIN (
  SELECT patch_id, COUNT(*)::int AS c
  FROM "user_patch_favorite_folder_relation"
  GROUP BY patch_id
) f ON f.patch_id = p.id
WHERE p.favorite_count IS DISTINCT FROM COALESCE(f.c, 0)`
  },
  {
    column: 'patch.resource_count',
    sql: `
SELECT COUNT(*)::int AS mismatched
FROM "patch" p
LEFT JOIN (
  SELECT patch_id, COUNT(*)::int AS c
  FROM "patch_resource"
  WHERE status = ${RESOURCE_STATUS.public}
  GROUP BY patch_id
) r ON r.patch_id = p.id
WHERE p.resource_count IS DISTINCT FROM COALESCE(r.c, 0)`
  },
  {
    column: 'patch.comment_count',
    sql: `
SELECT COUNT(*)::int AS mismatched
FROM "patch" p
LEFT JOIN (
  SELECT patch_id, COUNT(*)::int AS c
  FROM "patch_comment"
  WHERE status = ${COMMENT_STATUS.public} AND resource_id IS NULL
  GROUP BY patch_id
) c ON c.patch_id = p.id
WHERE p.comment_count IS DISTINCT FROM COALESCE(c.c, 0)`
  },
  {
    column: 'patch_tag.count',
    sql: `
SELECT COUNT(*)::int AS mismatched
FROM "patch_tag" p
LEFT JOIN (
  SELECT tag_id, COUNT(*)::int AS c
  FROM "patch_tag_relation"
  GROUP BY tag_id
) r ON r.tag_id = p.id
WHERE p.count IS DISTINCT FROM COALESCE(r.c, 0)`
  },
  {
    column: 'patch_company.count',
    sql: `
SELECT COUNT(*)::int AS mismatched
FROM "patch_company" p
LEFT JOIN (
  SELECT company_id, COUNT(*)::int AS c
  FROM "patch_company_relation"
  GROUP BY company_id
) r ON r.company_id = p.id
WHERE p.count IS DISTINCT FROM COALESCE(r.c, 0)`
  },
  {
    // 解析表达式与 db/migrations 里 patch_released_sort_trg 的函数体逐字一致,
    // 由 __tests__/migrationFiles.test.ts 守护; 触发器换代时两处一起改
    column: 'patch.released_sort',
    sql: `
SELECT COUNT(*)::int AS mismatched
FROM "patch"
WHERE released_sort IS DISTINCT FROM (
  CASE WHEN released ~ '^[0-9]{4}(-[0-9]{1,2}(-[0-9]{1,2})?)?$' THEN
      split_part(released, '-', 1)::int * 10000
      + COALESCE(NULLIF(split_part(released, '-', 2), '')::int, 0) * 100
      + COALESCE(NULLIF(split_part(released, '-', 3), '')::int, 0)
  END
)`
  }
]
