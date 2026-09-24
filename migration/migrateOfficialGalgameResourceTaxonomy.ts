// 一次性脚本：把官方账号 (user_id = 1) 的 galgame 下载资源从旧分类词表迁移到
// 872d5b9 引入的新词表 (galgame section 只允许 game/audio/image/video/other)。
// 旧 type 组合 → 新 type/platform 的映射见 RULE_BY_TYPE_KEY 与 decideResource；
// 模拟器型号 (emulator_type) 无法由旧数据推出, 借助 AI 从标题/备注/网盘文件名判定。
// 用法：pnpm esno migration/migrateOfficialGalgameResourceTaxonomy.ts [--dry-run] [--limit N]
//   --dry-run 只跑判定、写缓存与报告, 不写库
//   --limit N 只处理前 N 条 (按 id 升序), 用于抽查
// 幂等：迁移后 type 已是新词表, 再跑会被判为 done 跳过, 崩溃可直接重跑。
import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'
import { prisma } from '~/prisma/index'
import { recalcPatchType } from '~/app/api/patch/resource/_helper'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { drainSearchOutbox, enqueueSearchOutbox } from '~/server/search/sync'
import {
  RESOURCE_SECTION_TYPE_MAP,
  SUPPORTED_EMULATOR_TYPE
} from '~/constants/resource'

const OFFICIAL_USER_ID = 1
const SECTION = 'galgame'
const NEW_GALGAME_TYPES = RESOURCE_SECTION_TYPE_MAP.galgame

const PAN_HOST = 'pan.touchgal.net'
const PAN_SHARE_API = `https://${PAN_HOST}/api/v3/share`
const PAN_TIMEOUT_MS = 20 * 1000
const FETCH_CONCURRENCY = 5
const REQUEST_INTERVAL_MS = 120

const AI_MODEL = 'deepseek-v4-flash'
const AI_TIMEOUT_MS = 120 * 1000
const AI_ATTEMPTS = 3
const AI_NOTE_MAX_LENGTH = 500

const UPDATE_CHUNK_SIZE = 1000

const CACHE_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migrateOfficialGalgameResourceTaxonomy.cache.json'
)
const REPORT_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migrateOfficialGalgameResourceTaxonomy.report.md'
)

const AI_SYSTEM_PROMPT = `你是 Galgame 资源分类助手。根据资源的标题、备注与网盘文件名，判断该安卓资源是「模拟器资源」「直装 APK」还是无法确定。

模拟器型号代号映射（输出必须使用左侧代号）：
- krkr: KR、KRKR、吉里吉里、KiriKiri、krkr2、文件名以 .xp3 结尾
- ons: ONS、ONScripter
- winlator: Winlator
- joiplay: Joi、JoiPlay
- tyranor_artemis: TY、Ty、Tyranor、AR、Ar、Artemis
- gaishi: 盖世、盖世模拟器
- other: 明确出现「模拟器」字样但型号不在上表中

判断规则：
1. 仅当标题/备注/文件名中明确出现模拟器字样、型号或型号简写时，才判定为模拟器。
2. 文件名以 .xp3 结尾同样算明确证据，直接判定为 krkr（.xp3 是 KiriKiri 的封包格式）。
3. 一个资源可能同时适配多个模拟器：对每个型号分别判断，把有明确证据的型号代号全部放进 t 数组（按表中顺序），禁止输出没有证据的型号。
4. 仅当明确出现「直装」字样，或文件名以 .apk 结尾时，才判定为直装。
5. 除第 2 条外，没有明确证据时一律输出 uncertain，禁止根据游戏名称或引擎知识猜测。

只输出 JSON，禁止输出任何其他文本：
{"k":"emulator","t":["<型号代号>",...]} 或 {"k":"apk"} 或 {"k":"uncertain"}`

// ---------------------------------------------------------------------------
// 决策纯函数 (可单测, 不碰网络与数据库)
// ---------------------------------------------------------------------------

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5'

// 旧 type 组合 (去重排序后) → 规则。未列出的组合一律不迁移, 只记边角报告
const RULE_BY_TYPE_KEY: Record<string, RuleId> = {
  'chinese,pc': 'R1',
  'pc,row': 'R2',
  'app,chinese,mobile': 'R3',
  'app,mobile,row': 'R3',
  'chinese,emulator,mobile': 'R4',
  'emulator,mobile,row': 'R4',
  'chinese,mobile': 'R5'
}

export const setKey = (values: string[]) =>
  [...new Set(values)].sort().join(',')

export const matchRule = (type: string[]): RuleId | null =>
  RULE_BY_TYPE_KEY[setKey(type)] ?? null

// R4/R5 的目标 platform/emulator_type 无法从旧数据推出, 需要 AI 判定
export const ruleNeedsAi = (rule: RuleId | null) =>
  rule === 'R4' || rule === 'R5'

export type AiVerdict =
  { k: 'emulator'; t: string[] } | { k: 'apk' } | { k: 'uncertain' }

const aiVerdictSchema = z.union([
  z.object({
    k: z.literal('emulator'),
    t: z
      .array(z.string())
      .nonempty()
      .refine((types) =>
        types.every((type) => SUPPORTED_EMULATOR_TYPE.includes(type))
      )
      .transform((types) => [...new Set(types)])
  }),
  z.object({ k: z.literal('apk') }),
  z.object({ k: z.literal('uncertain') })
])

// 模型输出不可信: 围栏/非 JSON/枚举外型号一律降级为 uncertain, 由规则兜底,
// 而不是让脚本抛错中断 (与「AI 调用失败」区分开, 后者才是不迁移的理由)
export const parseAiVerdict = (raw: string): AiVerdict => {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return { k: 'uncertain' }
  }

  // 兼容缓存里的旧版单型号输出 {"t":"krkr"}, 避免重跑时全部降级为 uncertain
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as Record<string, unknown>).k === 'emulator' &&
    typeof (parsed as Record<string, unknown>).t === 'string'
  ) {
    parsed = {
      ...(parsed as Record<string, unknown>),
      t: [(parsed as Record<string, unknown>).t]
    }
  }

  const verdict = aiVerdictSchema.safeParse(parsed)
  return verdict.success ? verdict.data : { k: 'uncertain' }
}

export type ReportBucket =
  | 'r5-uncertain'
  | 'r4-unknown-emulator'
  | 'r3-ios'
  | 'other-combo'
  | 'ai-failed'
  | 'fetch-failed'

export interface ReportEntry {
  bucket: ReportBucket
  reason: string
}

// platform/emulator_type 缺省表示不改动该字段
export interface ResourceUpdate {
  type: string[]
  platform?: string[]
  emulator_type?: string[]
}

export type Decision =
  | { action: 'done' }
  | {
      action: 'migrate'
      rule: RuleId
      update: ResourceUpdate
      report?: ReportEntry
    }
  | { action: 'skip'; rule: RuleId | null; report: ReportEntry }

const toApk = (rule: RuleId, platform: string[]): Decision =>
  platform.includes('ios')
    ? {
        action: 'skip',
        rule,
        report: {
          bucket: 'r3-ios',
          reason: '平台含 ios, 无法确定是否为 Android 直装资源'
        }
      }
    : {
        action: 'migrate',
        rule,
        update: { type: ['game'], platform: ['apk'] }
      }

const toEmulator = (
  rule: RuleId,
  emulatorTypes: string[],
  report?: ReportEntry
): Decision => ({
  action: 'migrate',
  rule,
  update: {
    type: ['game'],
    platform: ['emulator'],
    emulator_type: emulatorTypes
  },
  report
})

// verdict 为 null 表示 AI 调用失败或未调用; 只有 R4/R5 会用到它
export const decideResource = (
  type: string[],
  platform: string[],
  verdict: AiVerdict | null
): Decision => {
  if (type.length > 0 && type.every((t) => NEW_GALGAME_TYPES.includes(t))) {
    return { action: 'done' }
  }

  const rule = matchRule(type)
  if (!rule) {
    return {
      action: 'skip',
      rule: null,
      report: {
        bucket: 'other-combo',
        reason: `未覆盖的 type 组合 {${setKey(type)}}`
      }
    }
  }

  // R1/R2 是 PC 资源, platform (windows/macos/linux) 本就是新词表, 不动
  if (rule === 'R1' || rule === 'R2') {
    return { action: 'migrate', rule, update: { type: ['game'] } }
  }

  if (rule === 'R3') {
    return toApk(rule, platform)
  }

  if (!verdict) {
    return {
      action: 'skip',
      rule,
      report: { bucket: 'ai-failed', reason: 'AI 判定调用失败' }
    }
  }

  if (rule === 'R4') {
    // 原分类已声明是模拟器资源, 型号判不出也照常迁移, 填 other 并记报告供人工复核
    if (verdict.k === 'emulator') {
      return toEmulator(rule, verdict.t)
    }
    return toEmulator(rule, ['other'], {
      bucket: 'r4-unknown-emulator',
      reason:
        verdict.k === 'apk'
          ? 'AI 判为直装, 与原模拟器分类矛盾, 型号未知'
          : 'AI 无法确定模拟器型号'
    })
  }

  // R5: 旧组合只说明是手机资源, 模拟器与直装二选一由 AI 分流, 判不出则不迁移
  if (verdict.k === 'emulator') {
    return toEmulator(rule, verdict.t)
  }
  if (verdict.k === 'apk') {
    return toApk(rule, platform)
  }
  return {
    action: 'skip',
    rule,
    report: {
      bucket: 'r5-uncertain',
      reason: 'AI 无法确定是模拟器资源还是直装 APK'
    }
  }
}

export const buildAiUserContent = (
  name: string,
  note: string,
  fileNames: string[]
) =>
  [
    `标题: ${name || '(空)'}`,
    `备注: ${note.slice(0, AI_NOTE_MAX_LENGTH) || '(空)'}`,
    '网盘文件名:',
    fileNames.length ? fileNames.map((n) => `- ${n}`).join('\n') : '(无)'
  ].join('\n')

// ---------------------------------------------------------------------------
// 运行时 (网络 / 数据库 / 文件)
// ---------------------------------------------------------------------------

const isDryRun = process.argv.includes('--dry-run')
const limitIndex = process.argv.indexOf('--limit')
const limit =
  limitIndex === -1
    ? undefined
    : Number(process.argv[limitIndex + 1]) || undefined

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const chunk = <T>(items: T[], size: number) => {
  const result: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size))
  }
  return result
}

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

const fetchPanJson = async (url: string) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(PAN_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`${url} 返回 ${response.status}`)
  }
  return await response.json()
}

// share/info 给出分享本身的名字 (单文件即文件名); is_dir 时再列目录拿全部文件名。
// list 路径必须带尾斜杠, 否则 301 且 fetch 跟随后拿不到 JSON
const fetchShareFileNames = async (content: string): Promise<string[]> => {
  const key = content.split('/').pop()
  if (!key) {
    return []
  }

  const info = await fetchPanJson(`${PAN_SHARE_API}/info/${key}`)
  if (info?.code !== 0) {
    throw new Error(`share/info ${key} code=${info?.code}`)
  }

  const names: string[] = []
  const sourceName = info?.data?.source?.name
  if (typeof sourceName === 'string' && sourceName) {
    names.push(sourceName)
  }

  if (info?.data?.is_dir) {
    const list = await fetchPanJson(`${PAN_SHARE_API}/list/${key}/`)
    if (list?.code !== 0) {
      throw new Error(`share/list ${key} code=${list?.code}`)
    }
    for (const object of list?.data?.objects ?? []) {
      if (typeof object?.name === 'string' && object.name) {
        names.push(object.name)
      }
    }
  }

  return names
}

const collectFileNames = async (links: { content: string }[]) => {
  const names: string[] = []
  let failed = false

  for (const link of links) {
    if (!link.content.includes(PAN_HOST)) {
      continue
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        names.push(...(await fetchShareFileNames(link.content)))
        break
      } catch (error) {
        if (attempt === 2) {
          failed = true
          console.error(`[抓取失败] ${link.content}:`, error)
        } else {
          await sleep(REQUEST_INTERVAL_MS)
        }
      }
    }
  }

  return { fileNames: [...new Set(names)], failed }
}

// 端点形态仿 server/moderation/ai.ts, 但不复用该模块 (它耦合审核语义与模型 env)
const requestAiRaw = async (userContent: string): Promise<string> => {
  const baseUrl = process.env.MODERATION_AI_BASE_URL!.replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.MODERATION_AI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      temperature: 0,
      // 与 moderation 取齐: 推理模型的思考也计入输出 token, 上限过小会让正文为空
      max_tokens: 10000
    })
  })
  if (!response.ok) {
    throw new Error(`AI 请求返回 ${response.status}`)
  }

  const data = await response.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(
      `AI 返回正文为空 (finish_reason: ${data?.choices?.[0]?.finish_reason ?? 'unknown'})`
    )
  }
  return content
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
  fileNames: string[]
  ai: string
}

// 只缓存「抓取与 AI 都成功」的结果: 失败条目留空, 下次重跑会重新抓取与判定
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

const writeCache = (cache: Record<string, CacheEntry>) => {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n')
}

interface ResourceRow {
  id: number
  name: string
  note: string
  type: string[]
  platform: string[]
  patch_id: number
  patch: { unique_id: string }
  links: { content: string }[]
}

interface ReportRow {
  resource: ResourceRow
  reason: string
}

const escapeCell = (value: string) =>
  value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')

const renderReportSection = (
  title: string,
  rows: ReportRow[],
  siteUrl: string
) => {
  const lines = [`## ${title} (${rows.length} 条)`, '']
  if (!rows.length) {
    lines.push('无', '')
    return lines.join('\n')
  }

  lines.push(
    '| 资源ID | 标题 | 条目ID | unique_id | 深链 | 原 type | 原 platform | 原因 |',
    '|---|---|---|---|---|---|---|---|'
  )
  // 抓取失败一节由并发 worker 写入, 排序使两次运行的报告可直接 diff
  for (const { resource, reason } of [...rows].sort(
    (a, b) => a.resource.id - b.resource.id
  )) {
    const link = `${siteUrl}/${resource.patch.unique_id}/resource/${resource.id}`
    lines.push(
      `| ${resource.id} | ${escapeCell(resource.name) || '(空)'} | ${resource.patch_id} | ` +
        `${resource.patch.unique_id} | ${link} | ${setKey(resource.type)} | ` +
        `${setKey(resource.platform) || '(空)'} | ${escapeCell(reason)} |`
    )
  }
  lines.push('')
  return lines.join('\n')
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

  const resources = (await prisma.patch_resource.findMany({
    where: { user_id: OFFICIAL_USER_ID, section: SECTION, status: 0 },
    orderBy: { id: 'asc' },
    ...(limit ? { take: limit } : {}),
    select: {
      id: true,
      name: true,
      note: true,
      type: true,
      platform: true,
      patch_id: true,
      patch: { select: { unique_id: true } },
      links: { select: { content: true } }
    }
  })) as ResourceRow[]
  console.log(
    `扫描到 ${resources.length} 条资源${isDryRun ? ' (dry-run)' : ''}${limit ? ` (--limit ${limit})` : ''}`
  )

  // 阶段一: 只对 R4/R5 抓网盘文件名并调用 AI, 结果写本地缓存供正式跑复用
  const aiTargets = resources.filter((resource) =>
    ruleNeedsAi(matchRule(resource.type))
  )
  const cache = readCache()
  const verdicts = new Map<number, AiVerdict | null>()
  const fetchFailedRows: ReportRow[] = []
  let cacheHit = 0
  let processed = 0

  console.log(`需要 AI 判定的资源 ${aiTargets.length} 条`)
  await runPool(aiTargets, FETCH_CONCURRENCY, async (resource) => {
    const cached = cache[resource.id]
    if (cached) {
      cacheHit++
      verdicts.set(resource.id, parseAiVerdict(cached.ai))
    } else {
      const { fileNames, failed } = await collectFileNames(resource.links)
      if (failed) {
        fetchFailedRows.push({
          resource,
          reason: '网盘文件名抓取失败, AI 仅凭标题与备注判定'
        })
      }

      const raw = await requestAiWithRetry(
        buildAiUserContent(resource.name, resource.note, fileNames)
      )
      if (raw === null) {
        verdicts.set(resource.id, null)
      } else {
        verdicts.set(resource.id, parseAiVerdict(raw))
        if (!failed) {
          cache[resource.id] = { fileNames, ai: raw }
        }
      }
    }

    processed++
    if (processed % 20 === 0) {
      writeCache(cache)
      console.log(`AI 判定进度 ${processed}/${aiTargets.length}`)
    }
  })
  writeCache(cache)
  console.log(
    `AI 判定完成: ${aiTargets.length} 条 (命中缓存 ${cacheHit} 条), 缓存已写入 ${CACHE_FILE}`
  )

  // 阶段二: 对全部资源做决策
  const migrations: { resource: ResourceRow; update: ResourceUpdate }[] = []
  const affectedPatchIds = new Set<number>()
  const reportRows: Record<ReportBucket, ReportRow[]> = {
    'r5-uncertain': [],
    'r4-unknown-emulator': [],
    'r3-ios': [],
    'other-combo': [],
    'ai-failed': [],
    'fetch-failed': fetchFailedRows
  }
  const ruleHits: Record<string, number> = {}
  let doneCount = 0

  for (const resource of resources) {
    const decision = decideResource(
      resource.type,
      resource.platform,
      verdicts.get(resource.id) ?? null
    )
    if (decision.action === 'done') {
      doneCount++
      // 已迁移的资源也算受影响: 若上次运行在「写资源」与「重算条目」之间中断, 重跑时
      // 这些资源全是 done, 不纳入就再也不会重算, 条目聚合字段会永久停留在旧值。
      // recalcPatchType 幂等, 重复重算只是慢, 不会写坏数据
      affectedPatchIds.add(resource.patch_id)
      continue
    }
    if (decision.report) {
      reportRows[decision.report.bucket].push({
        resource,
        reason: decision.report.reason
      })
    }
    if (decision.action === 'migrate') {
      migrations.push({ resource, update: decision.update })
      affectedPatchIds.add(resource.patch_id)
      ruleHits[decision.rule] = (ruleHits[decision.rule] ?? 0) + 1
    }
  }

  const overview = [
    ['扫描资源', resources.length],
    ['已是新词表, 跳过', doneCount],
    ['待迁移', migrations.length],
    ...(['R1', 'R2', 'R3', 'R4', 'R5'] as RuleId[]).map(
      (rule) => [`　${rule} 命中`, ruleHits[rule] ?? 0] as [string, number]
    ),
    ['R5 无法确定 (未迁移)', reportRows['r5-uncertain'].length],
    [
      'R4 型号未知, 填 other (已迁移)',
      reportRows['r4-unknown-emulator'].length
    ],
    ['R3 含 ios (未迁移)', reportRows['r3-ios'].length],
    ['其他边角组合 (未迁移)', reportRows['other-combo'].length],
    ['AI 调用失败 (未迁移)', reportRows['ai-failed'].length],
    ['网盘文件名抓取失败', reportRows['fetch-failed'].length],
    ['受影响的游戏条目', affectedPatchIds.size]
  ] as [string, number][]

  const report = [
    '# 官方 galgame 资源分类迁移报告',
    '',
    `- 模式: ${isDryRun ? 'dry-run (未写库)' : '正式执行'}`,
    `- 生成时间: ${new Date().toISOString()}`,
    `- 范围: user_id = ${OFFICIAL_USER_ID} AND section = '${SECTION}' AND status = 0${limit ? ` (--limit ${limit})` : ''}`,
    '',
    '## 概览',
    '',
    '| 项 | 数量 |',
    '|---|---|',
    ...overview.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    renderReportSection(
      'R5 无法确定 (未迁移)',
      reportRows['r5-uncertain'],
      siteUrl
    ),
    renderReportSection(
      'R4 型号未知, 已填 other (需人工复核)',
      reportRows['r4-unknown-emulator'],
      siteUrl
    ),
    renderReportSection('R3 含 ios (未迁移)', reportRows['r3-ios'], siteUrl),
    renderReportSection(
      '其他边角组合 (未迁移)',
      reportRows['other-combo'],
      siteUrl
    ),
    renderReportSection(
      '网盘文件名抓取失败',
      reportRows['fetch-failed'],
      siteUrl
    ),
    renderReportSection(
      'AI 调用失败 (未迁移)',
      reportRows['ai-failed'],
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

  // 阶段三: 写库。相同变更合并成 updateMany 批次, 15k 条不必逐行往返
  const groups = new Map<string, { update: ResourceUpdate; ids: number[] }>()
  for (const { resource, update } of migrations) {
    const signature = JSON.stringify(update)
    const group = groups.get(signature) ?? { update, ids: [] }
    group.ids.push(resource.id)
    groups.set(signature, group)
  }
  for (const group of groups.values()) {
    for (const ids of chunk(group.ids, UPDATE_CHUNK_SIZE)) {
      await prisma.patch_resource.updateMany({
        where: { id: { in: ids } },
        data: {
          type: { set: group.update.type },
          ...(group.update.platform
            ? { platform: { set: group.update.platform } }
            : {}),
          ...(group.update.emulator_type !== undefined
            ? { emulator_type: group.update.emulator_type }
            : {})
        }
      })
    }
    console.log(
      `已更新 ${group.ids.length} 条资源 -> ${JSON.stringify(group.update)}`
    )
  }

  // 阶段四: 资源改动后必须重算条目聚合字段 (type/language/platform), 并在同一事务
  // 写搜索出箱; 缓存失效只能在提交后 best-effort 执行
  let recalculated = 0
  for (const patchId of affectedPatchIds) {
    const uniqueId = await prisma.$transaction(async (tx) => {
      const id = await recalcPatchType(patchId, tx)
      await enqueueSearchOutbox(tx, patchId)
      return id
    })
    await invalidatePatchContentCache(uniqueId).catch((error: unknown) => {
      console.error(`[缓存失效失败] ${uniqueId}:`, error)
    })
    recalculated++
    if (recalculated % 200 === 0) {
      console.log(`条目重算进度 ${recalculated}/${affectedPatchIds.size}`)
    }
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
    `\n完成: 迁移 ${migrations.length} 条资源, 重算 ${affectedPatchIds.size} 个条目`
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
    .finally(() => prisma.$disconnect())
}
