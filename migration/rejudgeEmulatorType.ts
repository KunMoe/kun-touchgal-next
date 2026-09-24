// 一次性脚本: 把社区账号 (user_id != 1) 的 galgame 资源中「平台含模拟器且
// emulator_type 只选了 other」的记录, 用与 migrateCommunityGalgameResourceTaxonomy.ts
// P1 判定相同的型号映射表与证据权重规则重新判定模拟器型号并回填。
// 目标资源已确定是模拟器资源, 不再判断模拟器/直装 APK: AI 只输出型号数组,
// 判不出具体型号时输出 ["other"], 与原值相同故不改动, 写报告供人工复核。
// platform/type 等其他字段一律不动。
// 用法：pnpm esno migration/rejudgeEmulatorType.ts [--dry-run] [--limit N]
//   --dry-run 只跑判定、写缓存与报告, 不写库
//   --limit N 只处理前 N 条 (按 id 升序), 用于抽查
// 幂等：判定结果按资源 id 缓存, 重跑命中缓存; prompt 文案改动须删除 cache.json 重判。
import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { SUPPORTED_EMULATOR_TYPE } from '~/constants/resource'
import {
  buildAiUserContent,
  extractS3FileName,
  setKey
} from '~/migration/migrateCommunityGalgameResourceTaxonomy'

const OFFICIAL_USER_ID = 1
const SECTION = 'galgame'
// 缓存条目 kind: 判定口径变化 (prompt/schema 调整) 时换新值, 旧条目自然失效重判
const CACHE_KIND = 'emu-type-only'

const FETCH_CONCURRENCY = 32
const REQUEST_INTERVAL_MS = 60

const AI_MODEL = 'deepseek-v4-flash'
const AI_CHUNK_IDLE_TIMEOUT_MS = 240 * 1000
const AI_ATTEMPTS = 3

// 型号映射表与证据权重规则与迁移脚本 P1 prompt 一致, 只去掉模拟器/直装分流:
// 目标资源已确定是模拟器资源, AI 只需给出有明确证据的型号
const AI_EMU_TYPE_PROMPT = `你是 Galgame 资源分类助手。根据资源的标题、备注与网盘文件名，判断该安卓模拟器资源适配的模拟器型号。该资源已确定是模拟器资源，无需判断是否为模拟器或直装 APK。

模拟器型号代号映射（输出必须使用左侧代号）：
- krkr: KR、KRKR、吉里吉里、KiriKiri、krkr2、文件名以 .xp3 结尾
- ons: ONS、ONScripter
- winlator: Winlator
- joiplay: Joi、JoiPlay
- tyranor_artemis: TY、Ty、Tyranor、AR、Ar、Artemis
- gaishi: 盖世、盖世模拟器

证据权重：标题 > 网盘文件名 > 备注。用户常在备注中复制粘贴与资源本身无关的介绍文案，备注里提到的模拟器信息可能并不反映实际资源。判断必须以标题为主要依据，备注仅作辅助；仅出现在备注中、标题与文件名均无佐证的型号不得判定。

判断规则：
1. 仅当标题/备注/文件名中明确出现模拟器型号或型号简写时，才把对应代号放进 t 数组。
2. 文件名以 .xp3 结尾同样算明确证据，直接判定为 krkr（.xp3 是 KiriKiri 的封包格式）。
3. 一个资源可能同时适配多个模拟器：对每个型号分别判断，把有明确证据的型号代号全部放进 t 数组（按表中顺序），禁止输出没有证据的型号。
4. 没有任何型号的明确证据时输出 {"t":["other"]}，禁止根据游戏名称或引擎知识猜测。

只输出 JSON，禁止输出任何其他文本：
{"t":["<型号代号>",...]} 或 {"t":["other"]}`

const emulatorTypesSchema = z
  .array(z.string())
  .nonempty()
  .refine((types) =>
    types.every((type) => SUPPORTED_EMULATOR_TYPE.includes(type))
  )
  .transform((types) => [...new Set(types)])

// 模型输出不可信: 围栏/非 JSON/枚举外取值一律降级为 ['other'] (保持原值),
// 而不是让脚本抛错中断 (与「AI 调用失败」区分开)
export const parseEmulatorTypeVerdict = (raw: string): string[] => {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return ['other']
  }

  const verdict = z.object({ t: emulatorTypesSchema }).safeParse(parsed)
  return verdict.success ? verdict.data.t : ['other']
}

const CACHE_FILE = path.resolve(
  process.cwd(),
  'migration/backup/rejudgeEmulatorType.cache.json'
)
const REPORT_FILE = path.resolve(
  process.cwd(),
  'migration/backup/rejudgeEmulatorType.report.md'
)
const BACKUP_FILE = path.resolve(
  process.cwd(),
  'migration/backup/rejudgeEmulatorType.backup.json'
)

const isDryRun = process.argv.includes('--dry-run')
const limitIndex = process.argv.indexOf('--limit')
const limit =
  limitIndex === -1
    ? undefined
    : Number(process.argv[limitIndex + 1]) || undefined

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const runPool = async <T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) => {
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        await worker(items[index], index)
        await sleep(REQUEST_INTERVAL_MS)
      }
    })
  )
}

// 与迁移脚本同款的流式调用 (见该文件注释), 仅 system prompt 换成 P1
const requestAiRaw = async (userContent: string): Promise<string> => {
  const baseUrl = process.env.MODERATION_AI_BASE_URL!.replace(/\/+$/, '')
  const controller = new AbortController()
  let idleTimer = setTimeout(() => controller.abort(), AI_CHUNK_IDLE_TIMEOUT_MS)
  const renewIdleTimer = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), AI_CHUNK_IDLE_TIMEOUT_MS)
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.MODERATION_AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: 'system',
            // 只判模拟器型号, 不做模拟器/直装分流
            content: AI_EMU_TYPE_PROMPT
          },
          { role: 'user', content: userContent }
        ],
        temperature: 0,
        max_tokens: 10000,
        stream: true
      })
    })
    if (!response.ok) {
      throw new Error(`AI 请求返回 ${response.status}`)
    }
    if (!response.body) {
      throw new Error('AI 流式响应无 body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      renewIdleTimer()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        const chunk = JSON.parse(data)
        const delta = chunk.choices?.[0]?.delta
        if (typeof delta?.content === 'string') {
          content += delta.content
        }
      }
    }
    if (!content.trim()) {
      throw new Error('AI 流式返回正文为空')
    }
    return content
  } finally {
    clearTimeout(idleTimer)
  }
}

const requestAiWithRetry = async (
  userContent: string
): Promise<string | null> => {
  for (let attempt = 1; attempt <= AI_ATTEMPTS; attempt++) {
    try {
      return await requestAiRaw(userContent)
    } catch (error) {
      if (attempt === AI_ATTEMPTS) {
        console.error('[AI 调用失败]', error)
        return null
      }
      await sleep(REQUEST_INTERVAL_MS * attempt)
    }
  }
  return null
}

interface CacheEntry {
  kind: string
  fileNames: string[]
  ai: string
}

const readCache = (): Record<string, CacheEntry> => {
  if (!existsSync(CACHE_FILE)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Record<
      string,
      CacheEntry
    >
  } catch (error) {
    console.error('[缓存读取失败, 按空缓存处理]', error)
    return {}
  }
}

interface ResourceRow {
  id: number
  name: string
  note: string
  platform: string[]
  emulator_type: string[]
  user_id: number
  patch_id: number
  patch: { unique_id: string }
  links: { storage: string; content: string }[]
}

const run = async () => {
  for (const key of [
    'MODERATION_AI_BASE_URL',
    'MODERATION_AI_API_KEY',
    'KUN_VISUAL_NOVEL_SITE_URL'
  ]) {
    if (!process.env[key]) {
      throw new Error(`缺少环境变量 ${key}`)
    }
  }
  const siteUrl = process.env.KUN_VISUAL_NOVEL_SITE_URL!.replace(/\/+$/, '')

  // 目标: 平台含 emulator 且 emulator_type 恰为 {other} 的社区 galgame 资源 (全部 status)
  const resources = (await prisma.patch_resource.findMany({
    where: {
      user_id: { not: OFFICIAL_USER_ID },
      section: SECTION,
      platform: { has: 'emulator' },
      emulator_type: { equals: ['other'] }
    },
    orderBy: { id: 'asc' },
    ...(limit ? { take: limit } : {}),
    select: {
      id: true,
      name: true,
      note: true,
      platform: true,
      emulator_type: true,
      user_id: true,
      patch_id: true,
      patch: { select: { unique_id: true } },
      links: { select: { storage: true, content: true } }
    }
  })) as ResourceRow[]
  console.log(
    `扫描到 ${resources.length} 条待重判资源${isDryRun ? ' (dry-run)' : ''}${limit ? ` (--limit ${limit})` : ''}`
  )

  const cache = readCache()
  // 值为判出的型号数组; null 表示 AI 调用失败
  const verdicts = new Map<number, string[] | null>()
  let cacheHit = 0
  let processed = 0

  await runPool(resources, FETCH_CONCURRENCY, async (resource) => {
    const cached = cache[resource.id]
    if (cached && cached.kind === CACHE_KIND) {
      cacheHit++
      verdicts.set(resource.id, parseEmulatorTypeVerdict(cached.ai))
    } else {
      const fileNames = [
        ...new Set(
          resource.links
            .filter((link) => link.storage === 's3')
            .map((link) => extractS3FileName(link.content))
            .filter((name): name is string => name !== null)
        )
      ]
      const raw = await requestAiWithRetry(
        buildAiUserContent(resource.name, resource.note, fileNames)
      )
      if (raw === null) {
        verdicts.set(resource.id, null)
      } else {
        verdicts.set(resource.id, parseEmulatorTypeVerdict(raw))
        cache[resource.id] = { kind: CACHE_KIND, fileNames, ai: raw }
      }
    }

    processed++
    if (processed % 20 === 0) {
      writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n')
      console.log(`AI 判定进度 ${processed}/${resources.length}`)
    }
  })
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n')
  console.log(
    `AI 判定完成: ${resources.length} 条 (命中缓存 ${cacheHit} 条), 缓存已写入 ${CACHE_FILE}`
  )

  // 分流: 判出具体型号 -> 回填; 只有 other (判不出) -> 保持原值; null -> AI 失败
  const updates: { resource: ResourceRow; types: string[] }[] = []
  const keptRows: { resource: ResourceRow; reason: string }[] = []
  const failedRows: ResourceRow[] = []

  for (const resource of resources) {
    const types = verdicts.get(resource.id) ?? null
    if (!types) {
      failedRows.push(resource)
      continue
    }
    const concrete = types.filter((type) => type !== 'other')
    if (concrete.length > 0) {
      updates.push({ resource, types: concrete })
    } else {
      keptRows.push({ resource, reason: 'AI 无法确定具体型号, 保持 other' })
    }
  }

  const escapeCell = (value: string) =>
    value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
  const renderSection = (
    title: string,
    rows: { resource: ResourceRow; reason: string }[]
  ) => {
    const lines = [`## ${title} (${rows.length} 条)`, '']
    if (!rows.length) {
      lines.push('无', '')
      return lines.join('\n')
    }
    lines.push(
      '| 资源ID | 标题 | 条目ID | 深链 | 结果 |',
      '|---|---|---|---|---|'
    )
    for (const { resource, reason } of [...rows].sort(
      (a, b) => a.resource.id - b.resource.id
    )) {
      const link = `${siteUrl}/${resource.patch.unique_id}/resource/${resource.id}`
      lines.push(
        `| ${resource.id} | ${escapeCell(resource.name) || '(空)'} | ${resource.patch_id} | ${link} | ${escapeCell(reason)} |`
      )
    }
    lines.push('')
    return lines.join('\n')
  }

  const report = [
    '# 模拟器类型 other 重判报告',
    '',
    `- 模式: ${isDryRun ? 'dry-run (未写库)' : '正式执行'}`,
    `- 生成时间: ${new Date().toISOString()}`,
    `- 范围: user_id <> ${OFFICIAL_USER_ID} AND section = '${SECTION}' AND platform 含 emulator AND emulator_type = {other}${limit ? ` (--limit ${limit})` : ''}`,
    '',
    '## 概览',
    '',
    '| 项 | 数量 |',
    '|---|---|',
    `| 扫描资源 | ${resources.length} |`,
    `| 判定出新型号${isDryRun ? ' (待回填)' : ' (已回填)'} | ${updates.length} |`,
    `| 保持 other | ${keptRows.length} |`,
    `| AI 调用失败 (未改动) | ${failedRows.length} |`,
    '',
    renderSection(
      `判定出新型号${isDryRun ? ' (dry-run, 待回填)' : ' (已回填)'}`,
      updates.map(({ resource, types }) => ({
        resource,
        reason: `{${setKey(types)}}`
      }))
    ),
    renderSection('保持 other (需人工复核)', keptRows),
    renderSection(
      'AI 调用失败 (未改动)',
      failedRows.map((resource) => ({ resource, reason: 'AI 调用失败' }))
    )
  ].join('\n')
  writeFileSync(REPORT_FILE, report + '\n')
  console.log(`\n报告已写入 ${REPORT_FILE}`)
  console.log(`  判定出新型号: ${updates.length}`)
  console.log(`  保持 other: ${keptRows.length}`)
  console.log(`  AI 调用失败: ${failedRows.length}`)

  if (isDryRun) {
    console.log('\ndry-run 结束, 未写库')
    return
  }

  // 写库前备份原值; 重跑按 id 合并、已有条目不覆盖
  let backup: Record<string, { id: number; emulator_type: string[] }> = {}
  if (existsSync(BACKUP_FILE)) {
    try {
      backup = JSON.parse(readFileSync(BACKUP_FILE, 'utf-8'))
    } catch (error) {
      console.error('[备份读取失败, 重建]', error)
      backup = {}
    }
  }
  for (const { resource } of updates) {
    if (!(resource.id in backup)) {
      backup[resource.id] = {
        id: resource.id,
        emulator_type: resource.emulator_type
      }
    }
  }
  writeFileSync(BACKUP_FILE, JSON.stringify(backup, null, 2) + '\n')
  console.log(`原值备份已写入 ${BACKUP_FILE}`)

  // emulator_type 是资源自身字段, 不参与条目聚合 (recalcPatchType 只聚合
  // type/language/platform), 回填后无需重算条目
  const groups = new Map<string, { types: string[]; ids: number[] }>()
  for (const { resource, types } of updates) {
    const signature = setKey(types)
    const group = groups.get(signature) ?? { types, ids: [] }
    group.ids.push(resource.id)
    groups.set(signature, group)
  }
  for (const group of groups.values()) {
    await prisma.patch_resource.updateMany({
      where: { id: { in: group.ids } },
      data: { emulator_type: { set: group.types } }
    })
    console.log(
      `已更新 ${group.ids.length} 条资源 emulator_type -> {${setKey(group.types)}}`
    )
  }

  console.log(
    `\n完成: 回填 ${updates.length} 条, 保持 other ${keptRows.length} 条`
  )
}

const isDirectRun =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname

if (isDirectRun) {
  run()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(() => prisma.$disconnect())
}
