// 一次性脚本: winlator / gaishi 已从 SUPPORTED_EMULATOR_TYPE 词表删除, 本脚本遍历
// 全部下载资源 (全部 section / status / 用户), 把 emulator_type 里的这两个值去掉;
// 若去掉后资源不再有任何模拟器类型, 同时把 platform 里的 emulator 一并去掉
// (其余平台保留). platform 因此变空的资源照样写入, 但在报告里单列供人工处理,
// 不自行兜底补平台.
// 用法：pnpm esno migration/removeWinlatorGaishiEmulatorType.ts [--dry-run] [--limit N]
//   --dry-run 只生成报告, 不写库、不碰 Redis
//   --limit N 只处理前 N 条 (按 id 升序), 用于抽查
// 幂等：写库后不再有资源命中 hasSome, 重跑扫描到 0 条; 写库按条目分事务,
// 中断后重跑只会处理尚未写入的条目.
import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '~/prisma/index'
import { recalcPatchType } from '~/app/api/patch/resource/_helper'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { invalidatePatchResourceDetailCache } from '~/app/api/patch/resource/cache'
import { invalidateResourceListCache } from '~/app/api/resource/cache'
import { drainSearchOutbox, enqueueSearchOutbox } from '~/server/search/sync'
import { redis } from '~/lib/redis'

// 词表里已删除的模拟器类型 (constants 已无此二值, 故在此硬编码)
export const REMOVED_EMULATOR_TYPES = ['winlator', 'gaishi']

const REPORT_FILE = path.resolve(
  process.cwd(),
  'migration/backup/removeWinlatorGaishiEmulatorType.report.md'
)
const BACKUP_FILE = path.resolve(
  process.cwd(),
  'migration/backup/removeWinlatorGaishiEmulatorType.backup.json'
)

const isDryRun = process.argv.includes('--dry-run')
const limitIndex = process.argv.indexOf('--limit')
const limit =
  limitIndex === -1
    ? undefined
    : Number(process.argv[limitIndex + 1]) || undefined

// ---------------------------------------------------------------------------
// 决策纯函数 (可单测, 不碰数据库)
// ---------------------------------------------------------------------------

// trim-only: 只裁剪 emulator_type, platform 不动 (仍有其他模拟器类型, 或平台本就不含 emulator)
// drop-emulator: 模拟器类型清空, platform 去掉 emulator 后仍有其他平台
// drop-emulator-empty-platform: 模拟器类型清空, platform 去掉 emulator 后为空 (需人工处理)
export type DecisionKind =
  'trim-only' | 'drop-emulator' | 'drop-emulator-empty-platform'

export interface Decision {
  kind: DecisionKind
  emulator_type: string[]
  platform: string[]
}

// 返回 null 表示 emulator_type 不含待删值, 无需改动
export const decideResource = (
  platform: string[],
  emulatorType: string[]
): Decision | null => {
  if (!emulatorType.some((type) => REMOVED_EMULATOR_TYPES.includes(type))) {
    return null
  }
  const remaining = emulatorType.filter(
    (type) => !REMOVED_EMULATOR_TYPES.includes(type)
  )
  if (remaining.length > 0 || !platform.includes('emulator')) {
    return { kind: 'trim-only', emulator_type: remaining, platform }
  }
  const nextPlatform = platform.filter((p) => p !== 'emulator')
  return {
    kind:
      nextPlatform.length > 0
        ? 'drop-emulator'
        : 'drop-emulator-empty-platform',
    emulator_type: remaining,
    platform: nextPlatform
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

interface ResourceRow {
  id: number
  name: string
  section: string
  status: number
  platform: string[]
  emulator_type: string[]
  patch_id: number
  patch: { unique_id: string }
}

interface Change {
  resource: ResourceRow
  decision: Decision
}

const setKey = (values: string[]) => values.join(',')
const renderSet = (values: string[]) =>
  values.length ? `{${setKey(values)}}` : '(空)'
const escapeCell = (value: string) =>
  value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')

const renderSection = (title: string, rows: Change[], siteUrl: string) => {
  const lines = [`## ${title} (${rows.length} 条)`, '']
  if (!rows.length) {
    lines.push('无', '')
    return lines.join('\n')
  }
  lines.push(
    '| 资源ID | 标题 | 条目ID | 深链 | 原 platform | 原 emulator_type | 新 platform | 新 emulator_type |',
    '|---|---|---|---|---|---|---|---|'
  )
  for (const { resource, decision } of rows) {
    const link = `${siteUrl}/${resource.patch.unique_id}/resource/${resource.id}`
    lines.push(
      `| ${resource.id} | ${escapeCell(resource.name) || '(空)'} | ${resource.patch_id} | ${link} | ` +
        `${renderSet(resource.platform)} | ${renderSet(resource.emulator_type)} | ` +
        `${renderSet(decision.platform)} | ${renderSet(decision.emulator_type)} |`
    )
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const run = async () => {
  if (!process.env.KUN_VISUAL_NOVEL_SITE_URL) {
    throw new Error('缺少环境变量 KUN_VISUAL_NOVEL_SITE_URL')
  }
  const siteUrl = process.env.KUN_VISUAL_NOVEL_SITE_URL.replace(/\/+$/, '')

  // 目标: emulator_type 含 winlator / gaishi 的全部资源 (不限 section / status / 用户)
  const resources = (await prisma.patch_resource.findMany({
    where: { emulator_type: { hasSome: REMOVED_EMULATOR_TYPES } },
    orderBy: { id: 'asc' },
    ...(limit ? { take: limit } : {}),
    select: {
      id: true,
      name: true,
      section: true,
      status: true,
      platform: true,
      emulator_type: true,
      patch_id: true,
      patch: { select: { unique_id: true } }
    }
  })) as ResourceRow[]
  console.log(
    `扫描到 ${resources.length} 条待处理资源${isDryRun ? ' (dry-run)' : ''}${limit ? ` (--limit ${limit})` : ''}`
  )

  const changes: Change[] = []
  const buckets: Record<DecisionKind, Change[]> = {
    'trim-only': [],
    'drop-emulator': [],
    'drop-emulator-empty-platform': []
  }
  for (const resource of resources) {
    const decision = decideResource(resource.platform, resource.emulator_type)
    // 查询条件已保证命中, null 只是类型收窄
    if (!decision) continue
    const change = { resource, decision }
    changes.push(change)
    buckets[decision.kind].push(change)
  }

  // 按条目分组: 写库按条目分事务, platform 有变的条目需重算聚合字段
  const groups = new Map<number, Change[]>()
  for (const change of changes) {
    const group = groups.get(change.resource.patch_id) ?? []
    group.push(change)
    groups.set(change.resource.patch_id, group)
  }
  const patchIds = [...groups.keys()].sort((a, b) => a - b)
  const recalcPatchCount = patchIds.filter((patchId) =>
    groups.get(patchId)!.some(({ decision }) => decision.kind !== 'trim-only')
  ).length

  const overview: [string, number][] = [
    ['扫描资源', resources.length],
    ['只裁剪模拟器类型 (platform 不动)', buckets['trim-only'].length],
    ['去掉模拟器平台 (仍有其他平台)', buckets['drop-emulator'].length],
    [
      '去掉模拟器平台后 platform 为空 (需人工处理)',
      buckets['drop-emulator-empty-platform'].length
    ],
    ['受影响的条目', patchIds.length],
    ['需重算聚合字段的条目', recalcPatchCount]
  ]

  const report = [
    '# 删除 winlator / 盖世 模拟器类型迁移报告',
    '',
    `- 模式: ${isDryRun ? 'dry-run (未写库)' : '正式执行'}`,
    `- 生成时间: ${new Date().toISOString()}`,
    `- 范围: patch_resource.emulator_type 含 {${setKey(REMOVED_EMULATOR_TYPES)}} 的全部资源 (不限 section / status / 用户)${limit ? ` (--limit ${limit})` : ''}`,
    '',
    '## 概览',
    '',
    '| 项 | 数量 |',
    '|---|---|',
    ...overview.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    renderSection(
      '去掉模拟器平台后 platform 为空 (需人工处理)',
      buckets['drop-emulator-empty-platform'],
      siteUrl
    ),
    renderSection(
      '去掉模拟器平台 (仍有其他平台)',
      buckets['drop-emulator'],
      siteUrl
    ),
    renderSection(
      '只裁剪模拟器类型 (platform 不动)',
      buckets['trim-only'],
      siteUrl
    )
  ].join('\n')
  writeFileSync(REPORT_FILE, report + '\n')
  console.log(`\n报告已写入 ${REPORT_FILE}`)
  for (const [label, value] of overview) {
    console.log(`  ${label}: ${value}`)
  }

  if (isDryRun) {
    console.log('\ndry-run 结束, 未写库')
    return
  }
  if (!changes.length) {
    console.log('\n无待处理资源, 结束')
    return
  }

  // 写库前备份原值; 重跑按 id 合并、已有条目不覆盖
  let backup: Record<
    string,
    { id: number; platform: string[]; emulator_type: string[] }
  > = {}
  if (existsSync(BACKUP_FILE)) {
    try {
      backup = JSON.parse(readFileSync(BACKUP_FILE, 'utf-8'))
    } catch (error) {
      console.error('[备份读取失败, 重建]', error)
      backup = {}
    }
  }
  for (const { resource } of changes) {
    if (!(resource.id in backup)) {
      backup[resource.id] = {
        id: resource.id,
        platform: resource.platform,
        emulator_type: resource.emulator_type
      }
    }
  }
  writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2) + '\n')
  console.log(`原值备份已写入 ${BACKUP_FILE}`)

  // 逐条目一个事务: 资源改写 + 条目聚合字段重算 + 搜索出箱入队原子提交, 中断后
  // 重跑不会留下「资源已改、条目未重算」的半成品. 缓存失效只能在提交后 best-effort
  let needsListInvalidation = false
  let processed = 0
  for (const patchId of patchIds) {
    const group = groups.get(patchId)!
    const platformChanged = group.some(
      ({ decision }) => decision.kind !== 'trim-only'
    )
    const uniqueId = await prisma.$transaction(async (tx) => {
      for (const { resource, decision } of group) {
        await tx.patch_resource.update({
          where: { id: resource.id },
          data: {
            emulator_type: { set: decision.emulator_type },
            platform: { set: decision.platform }
          }
        })
      }
      if (!platformChanged) {
        // emulator_type 不参与条目聚合 (recalcPatchType 只聚合 type/language/platform)
        return null
      }
      const id = await recalcPatchType(patchId, tx)
      await enqueueSearchOutbox(tx, patchId)
      return id
    })

    if (uniqueId) {
      await invalidatePatchContentCache(uniqueId).catch((error: unknown) => {
        console.error(`[条目缓存失效失败] ${uniqueId}:`, error)
      })
    }
    // 资源详情缓存含 emulatorType 展示, 无论 platform 是否变化都要失效
    await invalidatePatchResourceDetailCache(patchId)
    if (
      group.some(
        ({ resource }) => resource.section === 'patch' && resource.status === 0
      )
    ) {
      needsListInvalidation = true
    }

    processed++
    if (processed % 100 === 0) {
      console.log(`条目处理进度 ${processed}/${patchIds.length}`)
    }
  }

  if (needsListInvalidation) {
    await invalidateResourceListCache()
  }

  // 写出箱单轮最多消费 200 行, 循环 drain 至清空; 未配 Meili 或不再减少时退出,
  // 剩余行由应用的定时任务兜底
  let prev = Infinity
  for (;;) {
    const remaining = await prisma.search_outbox.count()
    if (remaining === 0 || remaining >= prev) {
      break
    }
    console.log(`搜索写出箱剩余 ${remaining} 行`)
    prev = remaining
    await drainSearchOutbox()
  }

  console.log(
    `\n完成: 改写 ${changes.length} 条资源, 涉及 ${patchIds.length} 个条目 (重算 ${recalcPatchCount} 个)`
  )
}

// 仅在被直接执行时运行, 使单测可以只导入决策纯函数而不触发迁移与文件写入
const isDirectRun =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  run()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await prisma.$disconnect()
      // 缓存失效路径会建立 redis 连接, 不断开则 esno 进程挂住不退出
      redis.disconnect()
    })
}
