// 只读审计: 列出资源正式前缀 (patch/<数字>/resource/) 下没有任何资源链接引用的对象。
// 不删对象、不写库。要连生产库与真实的桶, 由站长人工执行:
//   pnpm exec esno scripts/auditResourceS3Orphans.ts > orphans.csv
// CSV 写 stdout (key, size_bytes, last_modified, in_outbox), 进度与汇总写 stderr。
//
// 引用判定与 S3 删除写出箱的消费者是同一个函数 (isS3ObjectReferenced), 列出来的正是消费者
// 会同意删除的对象。只看 LastModified 早于 48 小时的对象: bind 复制出 finalKey 到资源行提交
// 之间, 对象暂时没有引用, 不算孤儿。in_outbox 为 true 的已在删除写出箱里排队, 不是漏删。
// 用途: 给「是否在 patch_resource_link 上加删除触发器」提供孤儿规模的数据。
// lib/s3 在导入时就用环境变量建客户端, .env 必须先于它加载
import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ListObjectsV2Command } from '@aws-sdk/client-s3'
import { s3 } from '~/lib/s3'
import { prisma } from '~/prisma/index'
import { isS3ObjectReferenced } from '~/server/storage/references'

const MIN_AGE_MS = 48 * 60 * 60 * 1000
const RESOURCE_OBJECT_KEY = /^patch\/\d+\/resource\//

const csvField = (value: unknown) =>
  `"${String(value ?? '').replace(/"/g, '""')}"`

export const auditResourceS3Orphans = async ({
  emit,
  now = Date.now()
}: {
  emit: (line: string) => void
  now?: number
}) => {
  const summary = {
    listed: 0,
    resourceObjects: 0,
    tooRecent: 0,
    referenced: 0,
    orphans: 0,
    orphanBytes: 0,
    orphansInOutbox: 0
  }
  emit('key,size_bytes,last_modified,in_outbox')

  let continuationToken: string | undefined
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: process.env.KUN_VISUAL_NOVEL_S3_STORAGE_BUCKET_NAME!,
        Prefix: 'patch/',
        ContinuationToken: continuationToken
      })
    )
    for (const object of page.Contents ?? []) {
      summary.listed++
      if (!object.Key || !RESOURCE_OBJECT_KEY.test(object.Key)) {
        continue
      }
      summary.resourceObjects++
      if (
        !object.LastModified ||
        now - object.LastModified.getTime() < MIN_AGE_MS
      ) {
        summary.tooRecent++
        continue
      }
      if (await isS3ObjectReferenced(prisma, object.Key)) {
        summary.referenced++
        continue
      }
      const queued = await prisma.s3_deletion_outbox.findUnique({
        where: { s3_key: object.Key },
        select: { s3_key: true }
      })
      summary.orphans++
      summary.orphanBytes += object.Size ?? 0
      if (queued) {
        summary.orphansInOutbox++
      }
      emit(
        [
          object.Key,
          object.Size ?? 0,
          object.LastModified.toISOString(),
          Boolean(queued)
        ]
          .map(csvField)
          .join(',')
      )
    }
    console.error(
      `已列出 ${summary.listed} 个对象, 资源对象 ${summary.resourceObjects} 个, 孤儿 ${summary.orphans} 个`
    )
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined
  } while (continuationToken)

  return summary
}

// 仅在被直接执行时运行, 使单测可以只导入函数
const isDirectRun =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  auditResourceS3Orphans({ emit: (line) => process.stdout.write(`${line}\n`) })
    .then((summary) => {
      console.error(JSON.stringify(summary))
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
