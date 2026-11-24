-- phase: post
-- 标签别名、会社别名与会社母品牌的存量改成规范形 (T26): 每个值去掉首尾空白再转小写, 去掉空串,
-- 按首次出现的位置去重, 与 utils/term/normalize.ts 的 normalizeAliasList 逐项相同。新代码在入库前
-- 已经这样规范化 (validations/tag.ts、validations/company.ts), 这里只补存量; 补完并上线之后,
-- aliasLookupForms 才能收紧为只比规范形。
--
-- 与 JS 等价的依据:
-- - 去空白不用 btrim (它只去空格), 按 String.prototype.trim 的字符集 (WhiteSpace 与 LineTerminator)
--   写成显式码点, 与库的 locale 无关。
-- - 小写用 lower(), 随库的 LC_CTYPE。2026-11-24 生产只读核对: en_US.UTF-8 / libc, 会社别名 1795 个里
--   558 个 (417 行) 不是规范形, 首尾带空格以外空白的 0 个, 与本机副本完全一致; 本机副本 (同为
--   en_US.UTF-8 / libc) 上逐个比对 1788 个不重复值, lower() 与 JS 的 toLowerCase 0 个不一致。
--
-- 为什么是 post: 旧代码按原串比较别名 ({ alias: { has: q } }), 先回填会让旧代码用原来的大小写搜不到;
-- 新代码同时比原串与规范形, 回填前后都能搜到。
-- 锁: 每列一条 UPDATE, 只改有变化的行 (生产约 417 行); 不改键列, 与关联表插入取的 FOR KEY SHARE 相容,
-- 只与同一行上计数触发器的 UPDATE 互相短暂排队。
-- 回滚影响: 不可逆, 原来的大小写写法丢失 (会社页上的别名改为小写显示, 所有者 2026-11-24 已裁定接受)。
-- 回到旧构建不损坏数据, 只是旧代码按原串比较, 与库里写法大小写不同的输入搜不到。重复执行无变化。

UPDATE "patch_company" AS c
SET "alias" = n.normalized
FROM (
  SELECT src.id, ARRAY(
    SELECT s.k
    FROM (
      SELECT lower(regexp_replace(t.v, '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g')) AS k,
             min(t.ord) AS first_ord
      FROM unnest(src."alias") WITH ORDINALITY AS t(v, ord)
      GROUP BY 1
    ) AS s
    WHERE s.k <> ''
    ORDER BY s.first_ord
  ) AS normalized
  FROM "patch_company" AS src
  WHERE cardinality(src."alias") > 0
) AS n
WHERE c.id = n.id
  AND c."alias" <> n.normalized;

UPDATE "patch_company" AS c
SET "parent_brand" = n.normalized
FROM (
  SELECT src.id, ARRAY(
    SELECT s.k
    FROM (
      SELECT lower(regexp_replace(t.v, '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g')) AS k,
             min(t.ord) AS first_ord
      FROM unnest(src."parent_brand") WITH ORDINALITY AS t(v, ord)
      GROUP BY 1
    ) AS s
    WHERE s.k <> ''
    ORDER BY s.first_ord
  ) AS normalized
  FROM "patch_company" AS src
  WHERE cardinality(src."parent_brand") > 0
) AS n
WHERE c.id = n.id
  AND c."parent_brand" <> n.normalized;

UPDATE "patch_tag" AS c
SET "alias" = n.normalized
FROM (
  SELECT src.id, ARRAY(
    SELECT s.k
    FROM (
      SELECT lower(regexp_replace(t.v, '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g')) AS k,
             min(t.ord) AS first_ord
      FROM unnest(src."alias") WITH ORDINALITY AS t(v, ord)
      GROUP BY 1
    ) AS s
    WHERE s.k <> ''
    ORDER BY s.first_ord
  ) AS normalized
  FROM "patch_tag" AS src
  WHERE cardinality(src."alias") > 0
) AS n
WHERE c.id = n.id
  AND c."alias" <> n.normalized;
