import type { Prisma } from '~/prisma/generated/prisma/client'

type RefDb = Pick<Prisma.TransactionClient, '$queryRaw'>

// S3 资源对象还有没有人在用, 只由这里向 PostgreSQL 确认。唯一调用方是删除写出箱的消费者
// (drainS3DeletionOutbox): 入队端各自推断「本行独占本对象」, 但直传迁移 (bcc2c48f) 之前
// 的对象按「游戏 + 内容 BLAKE3 + 文件名」寻址, 同一游戏重复上传同一文件的几条链接共用一个
// 对象, 入队端怎么写都会删掉别人的文件。
//
// 引用的两种形态:
// - s3_key 非空: 精确相等。
// - 历史行 (s3_key 为空): content 恒为「存储地址/对象 key」, 以 content 的尾段为准, 不依赖
//   hash、patch_id 与域名 (hash 曾被保留分支写空, 旧 update 曾把对象传进别的游戏的前缀)。
//   right() 比尾段, 避开 LIKE 的转义; 拼上的 '/' 守住 patch/1 与 patch/10 的边界。只认
//   storage = 's3' 的行: content 恰好是桶地址的外链行不算引用。
// 判错的方向只有一个危险: 把在用判成无引用。多判成在用只会留下孤儿。
//
// 写入不变量 (消费端点查不加锁的依据): 对既有 key 新建引用, 只能在持有旧引用行的行锁下、同一
// 事务内复制 (今天只有 app/api/patch/resource/update.ts 的保留分支); 任何新 key 必须带随机段
// (bind 的 finalKey)。于是引用集合只会原子地「非空 → 非空」或「非空 → 空」, 「空 → 非空」
// 只发生在没人入队过的新 key 上。今后写 S3 key 的地方 (差分更新、上传会话、版本化指针列)
// 要守住这一条, 并在这里补上各自的持有者分支。
//
// s3_key 为空的历史行全部回填之后, 谓词收窄为 s3_key = key 的索引点查, 收窄单独发布。
// 在那之前历史分支是顺序扫描, 每次点查在毫秒级。
export const isS3ObjectReferenced = async (
  db: RefDb,
  key: string
): Promise<boolean> => {
  const [row] = await db.$queryRaw<{ referenced: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM patch_resource_link
      WHERE s3_key = ${key}::text
        OR (
          s3_key = ''
          AND storage = 's3'
          AND right(content, char_length(${key}::text) + 1) = '/' || ${key}::text
        )
    ) AS referenced`
  return row.referenced
}
