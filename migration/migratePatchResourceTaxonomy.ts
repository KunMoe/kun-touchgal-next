// 一次性脚本：把官方账号 (user_id = 1) 的 patch 下载资源从旧分类词表迁移到
// 872d5b9 引入的新词表 (manual/ai/machine/machine_polishing/save/crack/fix/
// mod/adult/uncensored/other)。旧数据只有 {chinese,patch}/{patch} 等粗粒度组合,
// 具体类型借助 AI 从标题/备注/网盘文件名判定; 判为 ai 时同一次调用一并提取
// 翻译模型型号写入 model_name (规范化官方命名, 判不出填「未知模型」)。
// 文件名来源: s3 链接直接取 URL 末段 (零网络), pan.touchgal.net 走 share API。
// 用法：pnpm esno migration/migratePatchResourceTaxonomy.ts [--dry-run] [--limit N]
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
  SUPPORTED_TYPE_MAP
} from '~/constants/resource'

const OFFICIAL_USER_ID = 1
const SECTION = 'patch'
const NEW_PATCH_TYPES = RESOURCE_SECTION_TYPE_MAP.patch
const TRANSLATION_TYPES = ['manual', 'ai', 'machine', 'machine_polishing']
const UNKNOWN_MODEL_NAME = '未知模型'

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
  'migration/backup/migratePatchResourceTaxonomy.cache.json'
)
const REPORT_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migratePatchResourceTaxonomy.report.md'
)
const BACKUP_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migratePatchResourceTaxonomy.backup.json'
)

const AI_SYSTEM_PROMPT = `你是 Galgame 补丁资源分类助手。根据资源的标题、备注、网盘文件名与原分类提示，判断该补丁资源的类型；判定为 AI 翻译补丁时，一并提取翻译使用的大模型型号。

类型代号（输出必须使用左侧代号）：
- manual: 人工翻译补丁（明确由汉化组或个人人工翻译制作）
- ai: AI 翻译补丁（由 AI 大模型翻译制作。标志：标题/文件名含大模型型号，如 GPT/ChatGPT/Claude/DeepSeek/Gemini/Sakura/Qwen/GLM 等，或含 AI 翻译工具名如 GalTransl；c35s/C3.5s 这类缩写指 Claude-3.5-Sonnet）
- machine: 传统机翻补丁（明确写明由传统机翻软件直接翻译，如 VNR/御坂/喵翻，且无大模型型号）
- machine_polishing: 传统机翻润色补丁（明确写明传统机翻基础上人工润色）
- save: 存档（如全 CG 存档、全回想存档、セーブデータ）
- crack: 破解补丁（破解、免认证、認証回避、免DVD、免CD、NoDVD、Crack）
- fix: 修正补丁（官方或第三方修正游戏问题的补丁，如修正パッチ、升级补丁、兼容补丁、环境运行补丁）
- mod: 魔改补丁（第三方魔改游戏内容）
- adult: 成人内容补丁（恢复或添加成人内容、R18 补丁、H 补丁）
- uncensored: 去码补丁（去除马赛克、モザイク除去）
- other: 其他（不属于以上任何一类，如配套字体、特典数据、追加内容、演出强化）

判断规则：
1. t 数组填 1-2 个类型代号：第 1 个是资源最主要的类型；仅当标题/备注/文件名明确表明资源同时包含第二种内容时（例如「翻译补丁内含免认证补丁」），才输出第 2 个类型，禁止猜测。
2. manual/ai/machine/machine_polishing 四种翻译类型互斥，t 中至多出现一个。
3. 翻译类的区分：出现大模型型号即为 ai；明确写明「机翻」且无大模型型号为 machine；写明「机翻润色」为 machine_polishing；明确写明汉化组/个人人工翻译为 manual。只写「汉化补丁」「翻译补丁」而无其他证据时无法区分，输出 uncertain。备注中的来源出处（如「翻译补丁来源2dfan 某某」）只是转载信息，不是翻译方式的证据。
4. 判定为 ai 时必须输出 m：翻译使用的大模型型号，规范化为官方命名风格（如 GPT-4o-0513、Claude-3.5-Sonnet-20240620、DeepSeek-V2.5、Gemini-2.5-Pro、SakuraLLM）；多个模型用「 + 」连接（如「ChatGPT + SakuraLLM」）；型号不要求带版本号，只写 GPT/ChatGPT/Sakura 这类名称时直接规范化输出（ChatGPT、SakuraLLM），不要因缺少版本号而填未知；仅当完全没有型号线索（含只有 GalTransl 这类工具名而无具体模型）时 m 填「${UNKNOWN_MODEL_NAME}」。t 不含 ai 时禁止输出 m。
5. 原分类提示：含 chinese 说明旧词表标记过「中文/汉化」，大概率是翻译类补丁；仅有 patch 无信息量。提示仅供参考，不作为证据。
6. 证据不足时一律输出 uncertain，禁止根据游戏名称或常识猜测。

只输出 JSON，禁止输出任何其他文本：
{"t":["<类型代号>",...],"m":"<模型型号>"} 或 {"t":["<类型代号>",...]} 或 {"k":"uncertain"}`

// ---------------------------------------------------------------------------
// 决策纯函数 (可单测, 不碰网络与数据库)
// ---------------------------------------------------------------------------

export const setKey = (values: string[]) =>
  [...new Set(values)].sort().join(',')

export type AiVerdict =
  { k: 'classified'; t: string[]; m?: string } | { k: 'uncertain' }

const classifiedShape = z
  .object({
    t: z.array(z.string()).min(1).max(2),
    m: z.string().trim().min(1).max(107).optional()
  })
  .transform(({ t, m }) => ({ t: [...new Set(t)], m }))
  .refine(({ t }) => t.every((type) => NEW_PATCH_TYPES.includes(type)))
  .refine(
    ({ t }) => t.filter((type) => TRANSLATION_TYPES.includes(type)).length <= 1
  )

// 模型输出不可信: 围栏/非 JSON/枚举外类型/双翻译类一律降级为 uncertain (记报告
// 人工处理), 而不是让脚本抛错中断。两处宽容: 含 ai 缺 m 时按用户裁定兜底
// 「未知模型」; 不含 ai 的多余 m 直接丢弃, 都不值得为此损失一次成功判定
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

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as Record<string, unknown>).k === 'uncertain'
  ) {
    return { k: 'uncertain' }
  }

  const verdict = classifiedShape.safeParse(parsed)
  if (!verdict.success) {
    return { k: 'uncertain' }
  }

  const { t, m } = verdict.data
  if (t.includes('ai')) {
    return { k: 'classified', t, m: m ?? UNKNOWN_MODEL_NAME }
  }
  return { k: 'classified', t }
}

// s3 链接形如 .../patch/<id>/resource/<hash>/<原始文件名>, 末段即文件名;
// 旧格式以对象 hash 结尾 (无文件名段) 时返回 null
export const extractS3FileName = (content: string): string | null => {
  let last: string | undefined
  try {
    last = new URL(content).pathname.split('/').filter(Boolean).pop()
  } catch {
    return null
  }
  if (!last || /^[0-9a-f]{32,}$/i.test(last)) {
    return null
  }
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

export type ReportBucket =
  | 'uncertain'
  | 'ai-failed'
  | 'fetch-failed'
  | 'second-type'
  | 'cross-over'
  | 'language-mismatch'

export interface ReportEntry {
  bucket: ReportBucket
  reason: string
}

export interface ResourceUpdate {
  type: string[]
  model_name?: string
}

export type Decision =
  | { action: 'done' }
  | { action: 'migrate'; update: ResourceUpdate; reports: ReportEntry[] }
  | { action: 'skip'; report: ReportEntry }

// verdict 为 null 表示 AI 调用失败; migrate 附带的 reports 是复核项, 不阻塞迁移
export const decideResource = (
  type: string[],
  language: string[],
  verdict: AiVerdict | null
): Decision => {
  if (type.length > 0 && type.every((t) => NEW_PATCH_TYPES.includes(t))) {
    return { action: 'done' }
  }

  if (!verdict) {
    return {
      action: 'skip',
      report: { bucket: 'ai-failed', reason: 'AI 判定调用失败' }
    }
  }
  if (verdict.k === 'uncertain') {
    return {
      action: 'skip',
      report: { bucket: 'uncertain', reason: 'AI 无法确定补丁类型' }
    }
  }

  const reports: ReportEntry[] = []
  const primary = verdict.t[0]
  const isTranslation = TRANSLATION_TYPES.includes(primary)

  if (verdict.t.length === 2) {
    reports.push({
      bucket: 'second-type',
      reason: `判定为多类型 {${verdict.t.join(',')}}`
    })
  }

  // 原组合含 chinese 提示翻译补丁, 不含提示非翻译补丁; 主类型与提示方向相反的
  // 样本可能是原数据标错 (确有实例), 照常迁移但单独列出供人工抽查
  const hintTranslation = type.includes('chinese')
  if (hintTranslation !== isTranslation) {
    reports.push({
      bucket: 'cross-over',
      reason: hintTranslation
        ? `原组合含 chinese 但判定为 ${primary}`
        : `原组合不含 chinese 但判定为 ${primary}`
    })
  }

  if (
    isTranslation &&
    !language.some((lang) => lang === 'zh-Hans' || lang === 'zh-Hant')
  ) {
    reports.push({
      bucket: 'language-mismatch',
      reason: `判定为翻译补丁但 language 为 {${setKey(language) || '空'}}, 本次不改 language`
    })
  }

  return {
    action: 'migrate',
    update: {
      type: verdict.t,
      ...(verdict.m ? { model_name: verdict.m } : {})
    },
    reports
  }
}

export const buildAiUserContent = (
  name: string,
  note: string,
  originalType: string[],
  fileNames: string[]
) =>
  [
    `标题: ${name || '(空)'}`,
    `备注: ${note.slice(0, AI_NOTE_MAX_LENGTH) || '(空)'}`,
    `原分类: {${setKey(originalType)}}`,
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

const collectFileNames = async (
  links: { storage: string; content: string }[]
) => {
  const names: string[] = []
  let failed = false

  for (const link of links) {
    if (link.storage === 's3') {
      const name = extractS3FileName(link.content)
      if (name) {
        names.push(name)
      }
      continue
    }
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
      // 推理模型的思考也计入输出 token, 上限过小会让正文为空或截断
      // (沿用审核队列的 2048 时实测出现过 JSON 截断)
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

interface BackupRow {
  id: number
  type: string[]
  model_name: string
}

// 写库前留存原值; 重跑时按 id 合并、已有条目不覆盖, 保证留下的是首次迁移前的原值
const writeBackup = (rows: BackupRow[]) => {
  let existing: Record<string, BackupRow> = {}
  if (existsSync(BACKUP_FILE)) {
    try {
      existing = JSON.parse(readFileSync(BACKUP_FILE, 'utf-8')) as Record<
        string,
        BackupRow
      >
    } catch (error) {
      console.error('[备份读取失败, 重建]', error)
      existing = {}
    }
  }
  for (const row of rows) {
    if (!(row.id in existing)) {
      existing[row.id] = row
    }
  }
  writeFileSync(BACKUP_FILE, JSON.stringify(existing, null, 2) + '\n')
}

interface ResourceRow {
  id: number
  name: string
  note: string
  type: string[]
  language: string[]
  model_name: string
  patch_id: number
  patch: { unique_id: string }
  links: { storage: string; content: string }[]
}

interface ReportRow {
  resource: ResourceRow
  reason: string
  newType?: string[]
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
    '| 资源ID | 标题 | 条目ID | unique_id | 深链 | 原 type | language | 新 type | 原因 |',
    '|---|---|---|---|---|---|---|---|---|'
  )
  // 抓取失败一节由并发 worker 写入, 排序使两次运行的报告可直接 diff
  for (const { resource, reason, newType } of [...rows].sort(
    (a, b) => a.resource.id - b.resource.id
  )) {
    const link = `${siteUrl}/${resource.patch.unique_id}/resource/${resource.id}`
    lines.push(
      `| ${resource.id} | ${escapeCell(resource.name) || '(空)'} | ${resource.patch_id} | ` +
        `${resource.patch.unique_id} | ${link} | ${setKey(resource.type)} | ` +
        `${setKey(resource.language) || '(空)'} | ` +
        `${newType ? newType.join(',') : '-'} | ${escapeCell(reason)} |`
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
      language: true,
      model_name: true,
      patch_id: true,
      patch: { select: { unique_id: true } },
      links: { select: { storage: true, content: true } }
    }
  })) as ResourceRow[]
  console.log(
    `扫描到 ${resources.length} 条资源${isDryRun ? ' (dry-run)' : ''}${limit ? ` (--limit ${limit})` : ''}`
  )

  // 阶段一: 对非新词表资源收集文件名并调用 AI, 结果写本地缓存供正式跑复用
  const aiTargets = resources.filter(
    (resource) =>
      !(
        resource.type.length > 0 &&
        resource.type.every((t) => NEW_PATCH_TYPES.includes(t))
      )
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
          reason: '网盘文件名抓取失败, AI 仅凭标题/备注/其余文件名判定'
        })
      }

      const raw = await requestAiWithRetry(
        buildAiUserContent(
          resource.name,
          resource.note,
          resource.type,
          fileNames
        )
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
    uncertain: [],
    'ai-failed': [],
    'fetch-failed': fetchFailedRows,
    'second-type': [],
    'cross-over': [],
    'language-mismatch': []
  }
  const primaryTypeHits: Record<string, number> = {}
  let doneCount = 0

  for (const resource of resources) {
    const decision = decideResource(
      resource.type,
      resource.language,
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
    if (decision.action === 'skip') {
      reportRows[decision.report.bucket].push({
        resource,
        reason: decision.report.reason
      })
      continue
    }
    for (const report of decision.reports) {
      reportRows[report.bucket].push({
        resource,
        reason: report.reason,
        newType: decision.update.type
      })
    }
    migrations.push({ resource, update: decision.update })
    affectedPatchIds.add(resource.patch_id)
    const primary = decision.update.type[0]
    primaryTypeHits[primary] = (primaryTypeHits[primary] ?? 0) + 1
  }

  const overview = [
    ['扫描资源', resources.length],
    ['已是新词表, 跳过', doneCount],
    ['待迁移', migrations.length],
    ...NEW_PATCH_TYPES.map(
      (type) =>
        [
          `　主类型 ${type} (${SUPPORTED_TYPE_MAP[type]})`,
          primaryTypeHits[type] ?? 0
        ] as [string, number]
    ),
    ['多类型样本 (已迁移, 需复核)', reportRows['second-type'].length],
    ['判定与原组合方向相反 (已迁移, 需复核)', reportRows['cross-over'].length],
    ['language 可疑 (已迁移, 需复核)', reportRows['language-mismatch'].length],
    ['AI 无法确定 (未迁移)', reportRows.uncertain.length],
    ['AI 调用失败 (未迁移)', reportRows['ai-failed'].length],
    ['网盘文件名抓取失败', reportRows['fetch-failed'].length],
    ['受影响的游戏条目', affectedPatchIds.size]
  ] as [string, number][]

  const report = [
    '# 官方 patch 资源分类迁移报告',
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
    renderReportSection('AI 无法确定 (未迁移)', reportRows.uncertain, siteUrl),
    renderReportSection(
      'AI 调用失败 (未迁移)',
      reportRows['ai-failed'],
      siteUrl
    ),
    renderReportSection(
      '判定与原组合方向相反 (已迁移, 需复核)',
      reportRows['cross-over'],
      siteUrl
    ),
    renderReportSection(
      '多类型样本 (已迁移, 需复核)',
      reportRows['second-type'],
      siteUrl
    ),
    renderReportSection(
      'language 可疑 (已迁移, 本次不改 language)',
      reportRows['language-mismatch'],
      siteUrl
    ),
    renderReportSection(
      '网盘文件名抓取失败',
      reportRows['fetch-failed'],
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

  // 阶段三: 写库前备份原值
  writeBackup(
    migrations.map(({ resource }) => ({
      id: resource.id,
      type: resource.type,
      model_name: resource.model_name
    }))
  )
  console.log(`原值备份已写入 ${BACKUP_FILE}`)

  // 阶段四: 写库。相同变更合并成 updateMany 批次; ai 类 model_name 各不相同,
  // 大多退化为单条批次, 本地库逐条跑也够快
  const groups = new Map<string, { update: ResourceUpdate; ids: number[] }>()
  for (const { resource, update } of migrations) {
    const signature = JSON.stringify(update)
    const group = groups.get(signature) ?? { update, ids: [] }
    group.ids.push(resource.id)
    groups.set(signature, group)
  }
  let processedGroups = 0
  for (const group of groups.values()) {
    for (const ids of chunk(group.ids, UPDATE_CHUNK_SIZE)) {
      await prisma.patch_resource.updateMany({
        where: { id: { in: ids } },
        data: {
          type: { set: group.update.type },
          ...(group.update.model_name !== undefined
            ? { model_name: group.update.model_name }
            : {})
        }
      })
    }
    processedGroups++
    if (processedGroups % 200 === 0) {
      console.log(`写库进度 ${processedGroups}/${groups.size} 组`)
    }
  }
  console.log(`已更新 ${migrations.length} 条资源 (${groups.size} 组)`)

  // 阶段五: 资源改动后必须重算条目聚合字段 (type/language/platform), 并在同一事务
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
