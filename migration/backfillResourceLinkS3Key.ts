/* eslint-disable no-console */
// 回填历史 S3 资源链接的 s3_key (直传迁移 bcc2c48f 之前写入的行, s3_key 为空)。
// 用法 (要连生产库与真实的桶, 由站长执行):
//   pnpm exec esno migration/backfillResourceLinkS3Key.ts           # dry-run: 只 HeadObject、分类、写报告
//   pnpm exec esno migration/backfillResourceLinkS3Key.ts --write   # 写入
// 报告写到 migration/backup/backfillResourceLinkS3Key.<dry-run|write>.csv, 一行一条链接。
//
// 为什么要回填: S3 删除写出箱的消费者删对象之前要确认没有链接还引用它
// (server/storage/references.ts)。历史行没有 s3_key, 只能按 content 尾段顺序扫描整张表;
// 回填完 (本脚本报告剩余 0 行) 之后谓词才能收窄为 s3_key = key 的索引点查, 收窄单独发布。
//
// 每行有两个候选: content 尾段 (主公式, content 恒为「存储地址/对象 key」) 与 resolveS3Key
// 的「游戏 id + hash + 文件名」(删除路径今天用的公式)。两式在 hash 被写空、或旧 update 把
// 对象传进别的游戏的前缀时不一致, 所以对每个候选做 HeadObject, 写入真实存在的那个:
// - consistent: 两式一致且对象存在。
// - divergent: 两式不一致且两个对象都在。写 content 尾段 (下载地址指向的那个); 另一个对象
//   是否有别的持有者, 按报告人工核对。
// - single: 只有一个候选的对象存在, 写它。
// - missing: 候选对象都不存在, 是既有死链。照样写 content 尾段 (没有尾段时写另一式), 使谓词
//   收窄前后判定不变; 运维若从桶的历史版本恢复对象, 恢复的就是这个 key。group_size > 1 的
//   多半是共享对象被删除其中一条链接时连带删掉的, 按 resource_id 交负责人处理。
// - unresolvable: 两式都算不出 key, 不写, 要人工处理, 否则剩余行数到不了 0。
//
// HeadObject 除 404 以外的错误 (鉴权、网络) 直接中止: 把它当成「不存在」会让分类失真。
// 写入以「仍是空 s3_key、content 未变」为条件, 不改 updated; 与编辑并发而没写成的行在报告里
// 标为 conflict, 编辑重建的新行也还是空 s3_key, 所以 --write 要跑两遍。
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prisma } from '~/prisma/index'
import { headObject } from '~/lib/s3'
import { resolveS3Key } from '~/app/api/patch/resource/_helper'
import { keyFromContent } from '~/server/storage/references'

export type LegacyLinkCategory =
  'consistent' | 'divergent' | 'single' | 'missing' | 'unresolvable'

interface LegacyLinkCandidates {
  tailKey: string | null
  tailExists: boolean
  resolvedKey: string | null
  resolvedExists: boolean
}

// 只看两个候选及其对象是否存在, 定出类别与要写入的 key
export const classifyLegacyLink = ({
  tailKey,
  tailExists,
  resolvedKey,
  resolvedExists
}: LegacyLinkCandidates): {
  category: LegacyLinkCategory
  key: string | null
} => {
  if (tailKey === null && resolvedKey === null) {
    return { category: 'unresolvable', key: null }
  }
  if (tailKey !== null && tailKey === resolvedKey) {
    return { category: tailExists ? 'consistent' : 'missing', key: tailKey }
  }
  const tailFound = tailKey !== null && tailExists
  const resolvedFound = resolvedKey !== null && resolvedExists
  if (tailFound && resolvedFound) {
    return { category: 'divergent', key: tailKey }
  }
  if (tailFound) {
    return { category: 'single', key: tailKey }
  }
  if (resolvedFound) {
    return { category: 'single', key: resolvedKey }
  }
  return { category: 'missing', key: tailKey ?? resolvedKey }
}

const objectExists = async (key: string) => {
  try {
    await headObject(key)
    return true
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode
    if (status === 404 || (error as { name?: string }).name === 'NotFound') {
      return false
    }
    throw new Error(`HeadObject ${key} 失败, 中止 (未写入的行重跑即可)`, {
      cause: error
    })
  }
}

const csvField = (value: unknown) =>
  `"${String(value ?? '').replace(/"/g, '""')}"`

const REPORT_COLUMNS = [
  'category',
  'result',
  'link_id',
  'resource_id',
  'patch_id',
  'group_size',
  'written_key',
  'tail_key',
  'tail_exists',
  'resolved_key',
  'resolved_exists'
] as const

type ReportRow = Record<(typeof REPORT_COLUMNS)[number], unknown>

export const backfillResourceLinkS3Key = async ({
  write
}: {
  write: boolean
}) => {
  const links = await prisma.patch_resource_link.findMany({
    where: { storage: 's3', s3_key: '' },
    select: {
      id: true,
      content: true,
      hash: true,
      resource_id: true,
      resource: { select: { patch_id: true } }
    },
    orderBy: { id: 'asc' }
  })

  const candidates = links.map((link) => {
    const tailKey = keyFromContent(link.content)
    return {
      link,
      tailKey,
      resolvedKey: resolveS3Key(link.content, link.resource.patch_id, link.hash)
    }
  })
  // 同一个对象被几条历史链接共用
  const groupSizes = new Map<string, number>()
  for (const { tailKey, resolvedKey } of candidates) {
    const groupKey = tailKey ?? resolvedKey
    if (groupKey) {
      groupSizes.set(groupKey, (groupSizes.get(groupKey) ?? 0) + 1)
    }
  }

  const existence = new Map<string, boolean>()
  const exists = async (key: string | null) => {
    if (key === null) {
      return false
    }
    const known = existence.get(key)
    if (known !== undefined) {
      return known
    }
    const found = await objectExists(key)
    existence.set(key, found)
    return found
  }

  const report: ReportRow[] = []
  const categories: Record<string, number> = {}
  const results: Record<string, number> = {}
  for (const [index, { link, tailKey, resolvedKey }] of candidates.entries()) {
    const tailExists = await exists(tailKey)
    const resolvedExists =
      resolvedKey === tailKey ? tailExists : await exists(resolvedKey)
    const { category, key } = classifyLegacyLink({
      tailKey,
      tailExists,
      resolvedKey,
      resolvedExists
    })

    let result = 'dry-run'
    if (key === null) {
      result = 'skipped'
    } else if (write) {
      const updated = await prisma.$executeRaw`
        UPDATE patch_resource_link SET s3_key = ${key}
        WHERE id = ${link.id} AND storage = 's3' AND s3_key = ''
          AND content = ${link.content}`
      result = updated === 1 ? 'written' : 'conflict'
    }
    categories[category] = (categories[category] ?? 0) + 1
    results[result] = (results[result] ?? 0) + 1
    report.push({
      category,
      result,
      link_id: link.id,
      resource_id: link.resource_id,
      patch_id: link.resource.patch_id,
      group_size: groupSizes.get(tailKey ?? resolvedKey ?? '') ?? 1,
      written_key: key,
      tail_key: tailKey,
      tail_exists: tailKey === null ? '' : tailExists,
      resolved_key: resolvedKey,
      resolved_exists: resolvedKey === null ? '' : resolvedExists
    })
    if ((index + 1) % 200 === 0) {
      console.log(`已处理 ${index + 1} / ${candidates.length}`)
    }
  }

  const remaining = await prisma.patch_resource_link.count({
    where: { storage: 's3', s3_key: '' }
  })
  return { scanned: links.length, categories, results, report, remaining }
}

const run = async () => {
  const write = process.argv.includes('--write')
  const mode = write ? 'write' : 'dry-run'
  const { scanned, categories, results, report, remaining } =
    await backfillResourceLinkS3Key({ write })

  const reportFile = `migration/backup/backfillResourceLinkS3Key.${mode}.csv`
  mkdirSync(path.dirname(reportFile), { recursive: true })
  writeFileSync(
    reportFile,
    [
      REPORT_COLUMNS.join(','),
      ...report.map((row) =>
        REPORT_COLUMNS.map((column) => csvField(row[column])).join(',')
      )
    ].join('\n') + '\n'
  )

  console.log(`\n模式: ${mode}, 扫描 s3_key 为空的 s3 链接 ${scanned} 条`)
  console.log(`  分类: ${JSON.stringify(categories)}`)
  console.log(`  结果: ${JSON.stringify(results)}`)
  console.log(`报告: ${reportFile}`)
  console.log(
    `剩余 s3_key 为空的 s3 链接: ${remaining} 条${remaining === 0 ? ' (可以发布收窄后的引用谓词)' : ''}`
  )
  if ((results.conflict ?? 0) > 0) {
    console.log('有与编辑并发而没写成的行, 再跑一遍 --write')
  }
}

// 仅在被直接执行时运行, 使单测可以只导入函数而不触发回填与文件写入
const isDirectRun =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  run()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
