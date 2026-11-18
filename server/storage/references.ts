import type { Prisma } from '~/prisma/generated/prisma/client'

type RefDb = Pick<Prisma.TransactionClient, '$queryRaw'>

// S3 资源对象还有没有人在用, 只由这里向 PostgreSQL 确认。唯一调用方是删除写出箱的消费者
// (drainS3DeletionOutbox): 入队端各自推断「本行独占本对象」, 但直传迁移 (bcc2c48f) 之前
// 的对象按「游戏 + 内容 BLAKE3 + 文件名」寻址, 同一游戏重复上传同一文件的几条链接共用一个
// 对象, 入队端怎么写都会删掉别人的文件。
//
// 引用就是 s3_key 精确相等, 走 patch_resource_link_s3_key_idx 的索引点查。早先 s3_key 为空的
// 历史行另按 content 尾段匹配; 2026-11-19 生产回填 (migration/backfillResourceLinkS3Key.ts)
// 报告剩余 0 行之后收窄成现在这样。前提是不再有 storage = 's3' 而 s3_key 为空的行: 新建资源
// 的 s3 链接都带 bind 的随机 key, 编辑保留的链接从原行复制 s3_key, 申诉不改 s3_key。
// 判错的方向只有一个危险: 把在用判成无引用。多判成在用只会留下孤儿。
//
// 写入不变量 (消费端点查不加锁的依据): 对既有 key 新建引用, 只能在持有旧引用行的行锁下、同一
// 事务内复制 (今天只有 app/api/patch/resource/update.ts 的保留分支); 任何新 key 必须带随机段
// (bind 的 finalKey)。于是引用集合只会原子地「非空 → 非空」或「非空 → 空」, 「空 → 非空」
// 只发生在没人入队过的新 key 上。今后写 S3 key 的地方 (差分更新、上传会话、版本化指针列)
// 要守住这一条, 写 storage = 's3' 的行必须同时写 s3_key, 并在这里补上各自的持有者分支。
export const isS3ObjectReferenced = async (
  db: RefDb,
  key: string
): Promise<boolean> => {
  const [row] = await db.$queryRaw<{ referenced: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM patch_resource_link WHERE s3_key = ${key}::text
    ) AS referenced`
  return row.referenced
}

const LEGACY_RESOURCE_KEY = /\/(patch\/\d+\/resource\/.+)$/

// 历史行的对象 key: content 里第一个「/patch/<数字>/resource/」之后 (含) 的尾段 (content 以
// '/' + 返回值结尾)。回填 s3_key 以它为主公式。
export const keyFromContent = (content: string): string | null =>
  LEGACY_RESOURCE_KEY.exec(content)?.[1] ?? null
