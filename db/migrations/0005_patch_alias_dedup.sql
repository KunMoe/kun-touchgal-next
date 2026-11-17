-- phase: post
-- 清掉 patch_alias 里同一条目下的重复别名, 每组保留 id 最小的一行。
-- 只合并逐字节相同的名字; 首尾空白不同的 ('a' 与 'a ') 留给下一次编辑时的规范化。
-- patch_alias 没有 (patch_id, name) 唯一约束 (name 是 VarChar(1007), 极端值超出 btree
-- 键长上限, 唯一索引已否决), 去重靠 app/api/edit/update.ts 写入前的 normalizeStringArray。
--
-- 为什么是 post: 必须晚于带去重逻辑的代码上线, 否则旧代码重新编辑条目时会把重复写回来。
-- 回滚影响: 无。回到旧构建只会重新产生重复别名, 不损坏数据。

DELETE FROM "patch_alias" a
USING "patch_alias" b
WHERE a.patch_id = b.patch_id
  AND a.name = b.name
  AND a.id > b.id;
