// 一次性脚本：把社区账号 (user_id != 1) 的 patch 下载资源从旧分类词表迁移到
// 872d5b9 引入的新词表 (patch section 允许 manual/ai/machine/machine_polishing/
// save/crack/fix/mod/adult/uncensored/other)。
// 与官方脚本 (migratePatchResourceTaxonomy.ts) 的差异：
// - 删除只在「原 type 含 tool/notice/row/app/emulator」的子集内判定 (本地实测 108
//   条, 走 triage prompt)：AI 确认确属这五类才删, 判为补丁则照常迁移。该子集之外的
//   资源根本不进删除判断 (patch prompt 里没有删除代号), 从结构上杜绝误删 —— 早期
//   版本让全量资源都可被判删, 抽检 8 条命中 2 条误判 (标题空/备注只有一句操作说明
//   的真补丁被判成公告), 且全量 24.5% 的资源标题+备注不足 12 字, 信号天然不足；
// - AI 判不出 (uncertain) 时按用户规则填 other 照常迁移, 不像官方脚本那样跳过；
// - 翻译方式「默认人工」(用户裁定)：未写明 AI/机翻/机翻润色的翻译补丁一律判 manual,
//   其中完全没写翻译方式的带 f 标记以便报告单列复核；
// - 社区链接大半是外部网盘 (storage=user), 拿不到文件名, 仅从 s3 链接提取；
// - 全部 status (0/1/2/3) 一并迁移, 隐藏/待审核资源解除后词表须一致；
// - platform 旧值 android/ios 一律改成 windows (用户裁定), 纯映射不经 AI。
// 用法：pnpm esno migration/migrateCommunityPatchResourceTaxonomy.ts [--dry-run] [--limit N]
//   --dry-run 只跑判定、写缓存与报告, 不写库不删除
//   --limit N 只处理前 N 条 (按 id 升序), 用于抽查
// 幂等：迁移后 type 已是新词表且 platform 无旧值, 再跑会被判为 done 跳过；纯 {other}
// 行新旧词表同名, 重跑会经缓存重判得到同一结果并写入同值, 无害。删除行重跑时已不存在。
// 注意：两段 system prompt 任一文案改动都必须删除 cache.json 重判 (缓存按 id + kind 命中)。
import 'dotenv/config'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'
import { prisma } from '~/prisma/index'
import {
  cleanupResourceCommentDerivatives,
  enqueueResourceLinkDeletions,
  recalcPatchType
} from '~/app/api/patch/resource/_helper'
import { invalidatePatchContentCache } from '~/app/api/patch/cache'
import { invalidateUserPendingResourceCache } from '~/app/api/utils/pendingResourceCache'
import { deletePendingModerationTasks } from '~/server/moderation/submit'
import { drainSearchOutbox, enqueueSearchOutbox } from '~/server/search/sync'
import { drainS3DeletionOutbox } from '~/server/storage/s3Outbox'
import {
  RESOURCE_SECTION_TYPE_MAP,
  SUPPORTED_TYPE_MAP
} from '~/constants/resource'

const OFFICIAL_USER_ID = 1
const SECTION = 'patch'
const NEW_PATCH_TYPES = RESOURCE_SECTION_TYPE_MAP.patch
const TRANSLATION_TYPES = ['manual', 'ai', 'machine', 'machine_polishing']
const UNKNOWN_MODEL_NAME = '未知模型'

// 旧词表里代表「不是补丁」的五个值。只有原 type 命中其一的资源才进删除判定 (用户
// 裁定), 且仍须 AI 确认确属该类才真删 —— 旧 type 是上传者当年的粗粒度标记, 实测
// 这 108 条里混着大量真补丁 (「绿茶汉化组 ty补丁」「Gemini-2.5-Pro 翻译补丁」)
const DELETE_CAUSES = ['tool', 'notice', 'row', 'app', 'emulator'] as const
export type DeleteCause = (typeof DELETE_CAUSES)[number]

// 旧 platform 词表值 -> 新值 (用户裁定: android/ios 全部改成 windows)
const PLATFORM_MIGRATION: Record<string, string> = {
  android: 'windows',
  ios: 'windows'
}

// 社区端点单次调用延迟高 (推理模型 ~15s), 并发放宽到 16 才能在可接受时间内跑完
const FETCH_CONCURRENCY = 16
const REQUEST_INTERVAL_MS = 120

const AI_MODEL = 'deepseek-v4-flash'
// 端点排队时单次调用可达 100s+, 超时放宽避免成批假失败
const AI_TIMEOUT_MS = 240 * 1000
const AI_ATTEMPTS = 3
const AI_NOTE_MAX_LENGTH = 500

const UPDATE_CHUNK_SIZE = 1000

const CACHE_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migrateCommunityPatchResourceTaxonomy.cache.json'
)
const REPORT_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migrateCommunityPatchResourceTaxonomy.report.md'
)
const BACKUP_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migrateCommunityPatchResourceTaxonomy.backup.json'
)

// 补丁类型代号段, 两段 prompt 共用。各类识别特征由用户逐条给定
const PATCH_TYPE_SECTION = `类型代号（输出必须使用左侧代号）：
- manual: 人工翻译补丁（汉化补丁 / 翻译补丁 / 中文补丁，且没有写明使用 AI 或传统机翻。写有汉化组、翻译组名称的，或明确写明人工翻译的，都属此类）
- ai: AI 翻译补丁（明确写明由 AI 大模型翻译。标志：标题/备注/文件名含大模型型号，如 GPT/ChatGPT/Claude/DeepSeek/Gemini/Sakura/Qwen/GLM 等，或含 AI 翻译工具名如 GalTransl；c35s/C3.5s 这类缩写指 Claude-3.5-Sonnet）
- machine: 传统机翻补丁（明确写明「机翻」，或写明由传统机翻软件直接翻译，如 VNR/御坂/喵翻，且无大模型型号）
- machine_polishing: 传统机翻润色补丁（明确写明「机翻润色」，或写明传统机翻基础上人工润色）
- save: 存档（标题或备注表明资源是存档，如全 CG 存档、全成就存档、全回想存档、通关存档、セーブデータ）
- crack: 破解补丁（破解补丁、免DVD补丁、免CD、NoDVD、Crack、软电池补丁、安装注册表、免注册补丁、免认证、認証回避）
- fix: 修正补丁（修正游戏问题的补丁，如「xxx 1.02 修正补丁」「xxx v1.1 升级补丁」这类带版本号的修正/升级补丁、修正パッチ、兼容补丁、环境运行补丁）
- mod: 魔改补丁（明确表明修改了游戏内行为逻辑或表现的第三方补丁）
- adult: 成人内容补丁（恢复或添加成人内容，如 Steam R18 修正补丁、裸体补丁、H 内容补丁、R18 补丁）
- uncensored: 去码补丁（明确出现「去码」二字，或去🐎、步兵、去马赛克、モザイク除去 等替代表达）
- other: 其他（不属于以上任何一类，如配套字体、特典数据、追加内容、演出强化）`

const PATCH_TYPE_RULES = `1. 先判断资源属于哪一类内容（翻译 / 存档 / 破解 / 修正 / 魔改 / 成人内容 / 去码 / 其他），再按下面的细则定档。
2. 翻译方式的判定以「默认人工」为准：只有明确写明使用 AI 大模型翻译（或出现大模型型号）才是 ai；明确写明「机翻」且无大模型型号才是 machine；明确写明「机翻润色」才是 machine_polishing；除此之外的翻译补丁一律判 manual —— 写有汉化组/翻译组名称的、明确写明人工翻译的属此类，完全没有写翻译方式的同样判 manual，此时额外输出 "f":1 标记该判定来自默认规则而非明确证据（有明确人工翻译证据或写明汉化组名称的不要输出 f）。备注中的来源出处（如「翻译补丁来源2dfan 某某」）只是转载信息，不是翻译方式的证据。
3. 成人内容补丁的优先级高于修正补丁：同时出现「R18」「H 内容」「裸体」与「修正/升级」字样时（如 Steam R18 修正补丁），判 adult 而不是 fix。
4. t 数组填 1-2 个类型代号：第 1 个是资源最主要的类型；仅当标题/备注/文件名明确表明资源同时包含第二种内容时（例如「翻译补丁内含免认证补丁」），才输出第 2 个类型，禁止猜测。
5. manual/ai/machine/machine_polishing 四种翻译类型互斥，t 中至多出现一个。
6. 判定为 ai 时必须输出 m：翻译使用的大模型型号，规范化为官方命名风格（如 GPT-4o-0513、Claude-3.5-Sonnet-20240620、DeepSeek-V2.5、Gemini-2.5-Pro、SakuraLLM）；多个模型用「 + 」连接（如「ChatGPT + SakuraLLM」）；型号不要求带版本号，只写 GPT/ChatGPT/Sakura 这类名称时直接规范化输出（ChatGPT、SakuraLLM），不要因缺少版本号而填未知；仅当完全没有型号线索（含只有 GalTransl 这类工具名而无具体模型）时 m 填「${UNKNOWN_MODEL_NAME}」。t 不含 ai 时禁止输出 m。
7. 原分类提示是上传者当年在旧词表下的选择，仅供参考不作为证据：含 chinese 说明标记过「中文/汉化」，大概率是翻译类；含 pc/mobile 只是平台标记，与类型无关。
8. 只有当标题与备注都看不出资源属于哪一类内容时才输出 uncertain，禁止根据游戏名称或常识猜测。`

// P-patch: 绝大多数资源走这段。刻意不含任何删除代号 —— 这批资源的删除与否不在本次
// 迁移范围内 (用户裁定), 模型没有输出删除的途径, 误删在结构上不可能发生
const AI_PATCH_PROMPT = `你是 Galgame 补丁资源分类助手。根据资源的标题、备注、网盘文件名与原分类提示，判断该补丁资源的类型；判定为 AI 翻译补丁时，一并提取翻译使用的大模型型号。

${PATCH_TYPE_SECTION}

判断规则：
${PATCH_TYPE_RULES}

只输出 JSON，禁止输出任何其他文本：
{"t":["<类型代号>",...],"m":"<模型型号>"} 或 {"t":["<类型代号>",...]} 或 {"t":["manual"],"f":1} 或 {"k":"uncertain"}`

// P-triage: 仅用于原分类含 tool/notice/row/app/emulator 的资源。先确认是否确属这五
// 类非补丁资源 (是则删除), 否则退回补丁类型判定
const AI_TRIAGE_PROMPT = `你是 Galgame 资源分类助手。以下资源被上传者标记过「工具/公告/生肉/安卓直装/模拟器」中的某一类，但旧标记未必准确。请先判断它到底是不是这五类非补丁资源，如果不是，再判断它属于哪种补丁。

非补丁类代号（判中时用删除格式输出）：
- tool: 工具软件。可独立运行、服务于多个游戏的通用软件，如 CE 修改器、虚拟光驱、模拟器程序本体、引擎解锁器、转区工具、翻译工具软件
- notice: 公告、攻略、说明文档、宣传信息等非文件资源
- row: 生肉游戏本体。未翻译的游戏本体、原版游戏、DL 版游戏
- app: 安卓直装游戏本体。直装 APK 形式的游戏本身
- emulator: 模拟器版游戏本体。用模拟器（KRKR/ONS/Winlator/JoiPlay 等）运行的游戏资源包本身

${PATCH_TYPE_SECTION}

判断规则：
0. 关键区分：「游戏本身」是非补丁类，「打进游戏的文件」是补丁。只对某一个游戏生效的修改/翻译/存档文件是补丁，即使它被标记过工具或模拟器；模拟器版游戏的汉化补丁仍是补丁，只有模拟器版游戏本体才是 emulator。资源同时含本体与补丁时按本体归入非补丁类。
${PATCH_TYPE_RULES}

删除格式的额外约束：无法确定它确属那五类非补丁资源时，不要输出删除格式，改按补丁类型判断。删除不可逆，只在证据明确时才输出删除格式。

只输出 JSON，禁止输出任何其他文本：
{"k":"delete","c":"<非补丁类代号>"} 或 {"t":["<类型代号>",...],"m":"<模型型号>"} 或 {"t":["<类型代号>",...]} 或 {"t":["manual"],"f":1} 或 {"k":"uncertain"}`

// ---------------------------------------------------------------------------
// 决策纯函数 (可单测, 不碰网络与数据库)
// ---------------------------------------------------------------------------

// 两段 prompt 对应的判定种类, 也是缓存条目的命中条件 (kind 不同视为未缓存)
export type AiKind = 'triage' | 'patch'

const SYSTEM_PROMPT_BY_KIND: Record<AiKind, string> = {
  triage: AI_TRIAGE_PROMPT,
  patch: AI_PATCH_PROMPT
}

export const setKey = (values: string[]) =>
  [...new Set(values)].sort().join(',')

// 只有原 type 命中五个非补丁旧值之一的资源才允许被判删除 (用户裁定)
export const aiKindFor = (type: string[]): AiKind =>
  DELETE_CAUSES.some((cause) => type.includes(cause)) ? 'triage' : 'patch'

// f 为真表示 manual 是「只知道是翻译补丁、分不清方式」的兜底判定 (用户裁定),
// 与有据的 manual 区分开只是为了报告能单列出来复核, 落库值完全相同
export type AiVerdict =
  | { k: 'classified'; t: string[]; m?: string; f?: boolean }
  | { k: 'delete'; c: DeleteCause }
  | { k: 'uncertain' }

const classifiedShape = z
  .object({
    t: z.array(z.string()).min(1).max(2),
    m: z.string().trim().min(1).max(107).optional(),
    f: z.union([z.boolean(), z.number()]).optional()
  })
  .transform(({ t, m, f }) => ({ t: [...new Set(t)], m, f: !!f }))
  .refine(({ t }) => t.every((type) => NEW_PATCH_TYPES.includes(type)))
  .refine(
    ({ t }) => t.filter((type) => TRANSLATION_TYPES.includes(type)).length <= 1
  )

const deleteShape = z.object({
  k: z.literal('delete'),
  c: z.enum(DELETE_CAUSES)
})

// 模型输出不可信: 围栏/非 JSON/枚举外类型/双翻译类一律降级为 uncertain (按用户规则
// 落 other 并记报告), 而不是让脚本抛错中断。两处宽容: 含 ai 缺 m 时按用户裁定兜底
// 「未知模型」; 不含 ai 的多余 m 直接丢弃, 都不值得为此损失一次成功判定
export const parseAiVerdict = (kind: AiKind, raw: string): AiVerdict => {
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

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as Record<string, unknown>).k === 'delete'
  ) {
    // patch 类资源不在删除范围内: 模型即便越界输出删除也一律拒收 (用户裁定的
    // 结构性护栏, 与 prompt 里不给删除代号互为双保险)。删除不可逆, c 缺失或
    // 越界同样降级
    if (kind !== 'triage') {
      return { k: 'uncertain' }
    }
    const deletion = deleteShape.safeParse(parsed)
    return deletion.success
      ? { k: 'delete', c: deletion.data.c }
      : { k: 'uncertain' }
  }

  const verdict = classifiedShape.safeParse(parsed)
  if (!verdict.success) {
    return { k: 'uncertain' }
  }

  const { t, m, f } = verdict.data
  // f 只对 manual 有意义, 贴到别的类型上属模型输出噪声, 丢弃
  const fallback = f && t[0] === 'manual' ? { f: true } : {}
  if (t.includes('ai')) {
    return { k: 'classified', t, m: m ?? UNKNOWN_MODEL_NAME, ...fallback }
  }
  return { k: 'classified', t, ...fallback }
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

// 返回 null 表示无需改动 platform (无旧值)
export const migratePlatform = (platform: string[]): string[] | null => {
  if (!platform.some((value) => value in PLATFORM_MIGRATION)) {
    return null
  }
  return [
    ...new Set(platform.map((value) => PLATFORM_MIGRATION[value] ?? value))
  ].sort()
}

export type ReportBucket =
  | 'deleted'
  | 'triage-kept'
  | 'uncertain-other'
  | 'translation-fallback'
  | 'unknown-model'
  | 'second-type'
  | 'platform-migrated'
  | 'ai-failed'

export interface ReportEntry {
  bucket: ReportBucket
  reason: string
}

// platform/model_name 缺省表示不改动该字段
export interface ResourceUpdate {
  type: string[]
  platform?: string[]
  model_name?: string
}

export type Decision =
  | { action: 'done' }
  | { action: 'delete'; cause: DeleteCause }
  | { action: 'migrate'; update: ResourceUpdate; reports: ReportEntry[] }
  | { action: 'skip'; report: ReportEntry }

// 纯 {other} 组合新旧词表同名, 若按 done 跳过就永远拿不到细分类型, 必须送 AI
export const needsAi = (type: string[]) =>
  setKey(type) === 'other' ||
  !(type.length > 0 && type.every((t) => NEW_PATCH_TYPES.includes(t)))

// verdict 为 null 表示 AI 调用失败; migrate 附带的 reports 是复核项, 不阻塞迁移
export const decideResource = (
  type: string[],
  platform: string[],
  modelName: string,
  verdict: AiVerdict | null
): Decision => {
  const migratedPlatform = migratePlatform(platform)
  const platformReports: ReportEntry[] = migratedPlatform
    ? [
        {
          bucket: 'platform-migrated',
          reason: `platform {${setKey(platform)}} 含旧值, 改为 {${migratedPlatform.join(',')}}`
        }
      ]
    : []

  if (!needsAi(type)) {
    // type 已是新词表: 仅当 ai 类缺型号或 platform 有旧值时才需要补写
    const needsModel = type.includes('ai') && !modelName
    if (!needsModel && !migratedPlatform) {
      return { action: 'done' }
    }
    return {
      action: 'migrate',
      update: {
        type,
        ...(migratedPlatform ? { platform: migratedPlatform } : {}),
        ...(needsModel ? { model_name: UNKNOWN_MODEL_NAME } : {})
      },
      reports: [
        ...platformReports,
        ...(needsModel
          ? [
              {
                bucket: 'unknown-model' as ReportBucket,
                reason: '已是 ai 类型但 model_name 为空, 补为未知模型'
              }
            ]
          : [])
      ]
    }
  }

  if (!verdict) {
    return {
      action: 'skip',
      report: { bucket: 'ai-failed', reason: 'AI 判定调用失败' }
    }
  }
  if (verdict.k === 'delete') {
    return { action: 'delete', cause: verdict.c }
  }

  const reports: ReportEntry[] = []
  // 原分类标记过非补丁类、AI 却判定它是补丁 —— 这正是「不按旧标记直删」要保住的
  // 那批资源, 单列供复核
  if (aiKindFor(type) === 'triage') {
    reports.push({
      bucket: 'triage-kept',
      reason: `原分类含 {${setKey(type.filter((t) => DELETE_CAUSES.some((c) => c === t)))}} 但 AI 判定为补丁资源, 保留`
    })
  }

  // 用户规则: 判不出就填「其他」照常迁移 (与官方脚本的跳过语义刻意不同)
  if (verdict.k === 'uncertain') {
    return {
      action: 'migrate',
      update: {
        type: ['other'],
        ...(migratedPlatform ? { platform: migratedPlatform } : {})
      },
      reports: [
        {
          bucket: 'uncertain-other',
          reason: 'AI 无法确定补丁类型, 按规则填其他'
        },
        ...reports,
        ...platformReports
      ]
    }
  }

  if (verdict.f) {
    reports.push({
      bucket: 'translation-fallback',
      reason: '未写明翻译方式, 按默认规则判为人工翻译补丁'
    })
  }
  if (verdict.t.length === 2) {
    reports.push({
      bucket: 'second-type',
      reason: `判定为多类型 {${verdict.t.join(',')}}`
    })
  }
  if (verdict.m === UNKNOWN_MODEL_NAME) {
    reports.push({
      bucket: 'unknown-model',
      reason: 'AI 判为 ai 翻译补丁但无法提取模型型号'
    })
  }
  reports.push(...platformReports)

  return {
    action: 'migrate',
    update: {
      type: verdict.t,
      ...(migratedPlatform ? { platform: migratedPlatform } : {}),
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

// 端点形态仿 server/moderation/ai.ts, 但不复用该模块 (它耦合审核语义与模型 env)
const requestAiRaw = async (
  kind: AiKind,
  userContent: string
): Promise<string> => {
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
        { role: 'system', content: SYSTEM_PROMPT_BY_KIND[kind] },
        { role: 'user', content: userContent }
      ],
      temperature: 0,
      // 推理模型的思考也计入输出 token, 上限过小会让正文为空或截断
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
  kind: AiKind,
  userContent: string
): Promise<string | null> => {
  for (let attempt = 1; attempt <= AI_ATTEMPTS; attempt++) {
    try {
      return await requestAiRaw(kind, userContent)
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
  kind: AiKind
  fileNames: string[]
  ai: string
}

// 只缓存 AI 调用成功的结果; kind 不同 (判定种类变化) 视为未缓存
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
  model_name: string
  status: number
  user_id: number
  patch_id: number
  patch: { unique_id: string }
  links: { storage: string; content: string; hash: string; s3_key: string }[]
}

interface BackupState {
  updated: Record<
    string,
    { id: number; type: string[]; platform: string[]; model_name: string }
  >
  deleted: Record<string, ResourceRow>
}

// 写库/删除前留存原值; 重跑时按 id 合并、已有条目不覆盖, 留下的是首次执行前的原值
const writeBackup = (
  updatedRows: ResourceRow[],
  deletedRows: ResourceRow[]
) => {
  let existing: BackupState = { updated: {}, deleted: {} }
  if (existsSync(BACKUP_FILE)) {
    try {
      existing = JSON.parse(readFileSync(BACKUP_FILE, 'utf-8')) as BackupState
      existing.updated ??= {}
      existing.deleted ??= {}
    } catch (error) {
      console.error('[备份读取失败, 重建]', error)
      existing = { updated: {}, deleted: {} }
    }
  }
  for (const row of updatedRows) {
    if (!(row.id in existing.updated)) {
      existing.updated[row.id] = {
        id: row.id,
        type: row.type,
        platform: row.platform,
        model_name: row.model_name
      }
    }
  }
  for (const row of deletedRows) {
    if (!(row.id in existing.deleted)) {
      existing.deleted[row.id] = row
    }
  }
  writeFileSync(BACKUP_FILE, JSON.stringify(existing, null, 2) + '\n')
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
    '| 资源ID | 标题 | 条目ID | unique_id | 深链 | 原 type | 原 platform | 新 type | 原因 |',
    '|---|---|---|---|---|---|---|---|---|'
  )
  // 排序使两次运行的报告可直接 diff
  for (const { resource, reason, newType } of [...rows].sort(
    (a, b) => a.resource.id - b.resource.id
  )) {
    const link = `${siteUrl}/${resource.patch.unique_id}/resource/${resource.id}`
    lines.push(
      `| ${resource.id} | ${escapeCell(resource.name) || '(空)'} | ${resource.patch_id} | ` +
        `${resource.patch.unique_id} | ${link} | ${setKey(resource.type)} | ` +
        `${setKey(resource.platform) || '(空)'} | ` +
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

  // 不过滤 status: 隐藏 (1) 与待审核 (2/3) 的资源解除后词表也必须是新的
  const resources = (await prisma.patch_resource.findMany({
    where: { user_id: { not: OFFICIAL_USER_ID }, section: SECTION },
    orderBy: { id: 'asc' },
    ...(limit ? { take: limit } : {}),
    select: {
      id: true,
      name: true,
      note: true,
      type: true,
      platform: true,
      model_name: true,
      status: true,
      user_id: true,
      patch_id: true,
      patch: { select: { unique_id: true } },
      links: {
        select: { storage: true, content: true, hash: true, s3_key: true }
      }
    }
  })) as ResourceRow[]
  const triageCount = resources.filter(
    (resource) => aiKindFor(resource.type) === 'triage'
  ).length
  console.log(
    `扫描到 ${resources.length} 条资源${isDryRun ? ' (dry-run)' : ''}${limit ? ` (--limit ${limit})` : ''}`
  )
  console.log(
    `其中 ${triageCount} 条原分类含 {${DELETE_CAUSES.join('/')}}, 走 triage 判定 (仅这批可能被删除)`
  )

  // 阶段一: 对需要 AI 的资源判定, 结果写本地缓存供正式跑复用。社区链接大半是外部
  // 网盘, 文件名只能从 s3 链接的 URL 末段提取, 无网络抓取
  const aiTargets = resources.filter((resource) => needsAi(resource.type))
  const cache = readCache()
  const verdicts = new Map<number, AiVerdict | null>()
  let cacheHit = 0
  let processed = 0

  console.log(`需要 AI 判定的资源 ${aiTargets.length} 条`)
  await runPool(aiTargets, FETCH_CONCURRENCY, async (resource) => {
    const kind = aiKindFor(resource.type)
    const cached = cache[resource.id]
    if (cached && cached.kind === kind) {
      cacheHit++
      verdicts.set(resource.id, parseAiVerdict(kind, cached.ai))
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
        kind,
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
        verdicts.set(resource.id, parseAiVerdict(kind, raw))
        cache[resource.id] = { kind, fileNames, ai: raw }
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
  const deletions: ResourceRow[] = []
  const affectedPatchIds = new Set<number>()
  const reportRows: Record<ReportBucket, ReportRow[]> = {
    deleted: [],
    'triage-kept': [],
    'uncertain-other': [],
    'translation-fallback': [],
    'unknown-model': [],
    'second-type': [],
    'platform-migrated': [],
    'ai-failed': []
  }
  const primaryTypeHits: Record<string, number> = {}
  const deleteCauseHits: Record<string, number> = {}
  let doneCount = 0

  for (const resource of resources) {
    const decision = decideResource(
      resource.type,
      resource.platform,
      resource.model_name,
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
    if (decision.action === 'delete') {
      deletions.push(resource)
      deleteCauseHits[decision.cause] =
        (deleteCauseHits[decision.cause] ?? 0) + 1
      reportRows.deleted.push({
        resource,
        reason: `AI 确认为 ${decision.cause} (非补丁资源)${isDryRun ? ', 待删除' : ', 已删除'}`
      })
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
    ['　其中走 triage 判定 (可能被删除)', triageCount],
    ['已是新词表, 跳过', doneCount],
    ['待迁移', migrations.length],
    ...NEW_PATCH_TYPES.map(
      (type) =>
        [
          `　主类型 ${type} (${SUPPORTED_TYPE_MAP[type]})`,
          primaryTypeHits[type] ?? 0
        ] as [string, number]
    ),
    ['删除 (AI 确认为非补丁资源)', deletions.length],
    ...DELETE_CAUSES.map(
      (cause) =>
        [`　删除 ${cause}`, deleteCauseHits[cause] ?? 0] as [string, number]
    ),
    ['原分类含非补丁标记但判为补丁, 已保留', reportRows['triage-kept'].length],
    ['AI 判不出, 已填其他 (需复核)', reportRows['uncertain-other'].length],
    [
      '未写明翻译方式, 判为人工翻译 (已迁移, 需复核)',
      reportRows['translation-fallback'].length
    ],
    ['模型型号未知 (已迁移, 需复核)', reportRows['unknown-model'].length],
    ['多类型样本 (已迁移, 需复核)', reportRows['second-type'].length],
    ['platform 旧值已迁移', reportRows['platform-migrated'].length],
    ['AI 调用失败 (未迁移)', reportRows['ai-failed'].length],
    ['受影响的游戏条目', affectedPatchIds.size]
  ] as [string, number][]

  const report = [
    '# 社区 patch 资源分类迁移报告',
    '',
    `- 模式: ${isDryRun ? 'dry-run (未写库)' : '正式执行'}`,
    `- 生成时间: ${new Date().toISOString()}`,
    `- 范围: user_id <> ${OFFICIAL_USER_ID} AND section = '${SECTION}' (全部 status)${limit ? ` (--limit ${limit})` : ''}`,
    `- 删除候选: 仅原 type 含 {${DELETE_CAUSES.join('/')}} 的 ${triageCount} 条, 其余资源不进删除判断`,
    '',
    '## 概览',
    '',
    '| 项 | 数量 |',
    '|---|---|',
    ...overview.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    renderReportSection(
      `删除留档${isDryRun ? ' (dry-run, 未删除)' : ''}`,
      reportRows.deleted,
      siteUrl
    ),
    renderReportSection(
      '原分类含非补丁标记但 AI 判为补丁, 已保留 (需复核)',
      reportRows['triage-kept'],
      siteUrl
    ),
    renderReportSection(
      'AI 判不出, 已填其他 (需复核)',
      reportRows['uncertain-other'],
      siteUrl
    ),
    renderReportSection(
      '未写明翻译方式, 按默认规则判为人工翻译补丁 (已迁移, 需复核)',
      reportRows['translation-fallback'],
      siteUrl
    ),
    renderReportSection(
      '模型型号未知 (已迁移, 需复核)',
      reportRows['unknown-model'],
      siteUrl
    ),
    renderReportSection(
      '多类型样本 (已迁移, 需复核)',
      reportRows['second-type'],
      siteUrl
    ),
    renderReportSection(
      'platform 旧值已迁移 (android/ios -> windows)',
      reportRows['platform-migrated'],
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

  // 阶段三: 写库/删除前备份原值 (删除不可逆, 留全量行含 links)
  writeBackup(
    migrations.map(({ resource }) => resource),
    deletions
  )
  console.log(`原值备份已写入 ${BACKUP_FILE}`)

  // 阶段四: 删除。逐条事务复刻 app/api/patch/resource/delete.ts 的删除语义
  // (评论衍生物清理/审核任务/条目重算/搜索出箱/S3 删除出箱), 但不扣萌萌点不发通知
  let deletedCount = 0
  for (const resource of deletions) {
    const s3Links = resource.links.filter((link) => link.storage === 's3')
    const uniqueId = await prisma.$transaction(async (tx) => {
      await cleanupResourceCommentDerivatives(tx, resource.id)
      await tx.patch_resource.delete({ where: { id: resource.id } })
      await deletePendingModerationTasks('resource', resource.id, tx)
      const id = await recalcPatchType(resource.patch_id, tx)
      await enqueueSearchOutbox(tx, resource.patch_id)
      await enqueueResourceLinkDeletions(
        tx,
        s3Links.map((link) => ({
          content: link.content,
          patchId: resource.patch_id,
          hash: link.hash,
          s3Key: link.s3_key
        }))
      )
      return id
    })
    await invalidatePatchContentCache(uniqueId).catch((error: unknown) => {
      console.error(`[缓存失效失败] ${uniqueId}:`, error)
    })
    // 删除待审核资源后作者的 hasPendingResource 可能翻假, 失效以尽早停止 bypass
    if (resource.status === 2 || resource.status === 3) {
      await invalidateUserPendingResourceCache(resource.user_id)
    }
    deletedCount++
    if (deletedCount % 20 === 0) {
      console.log(`删除进度 ${deletedCount}/${deletions.length}`)
    }
  }
  if (deletions.length) {
    console.log(`删除完成: ${deletions.length} 条`)
  }

  // 阶段五: 写库。相同变更合并成 updateMany 批次; ai 类 model_name 各不相同,
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
          ...(group.update.platform
            ? { platform: { set: group.update.platform } }
            : {}),
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

  // 阶段六: 资源改动后必须重算条目聚合字段 (type/language/platform), 并在同一事务
  // 写搜索出箱; 缓存失效只能在提交后 best-effort 执行。删除行所属条目已在删除事务内
  // 重算, 不在此重复
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

  // 写出箱单轮最多消费固定行数, 循环 drain 至清空; 未配后端或不再减少时退出,
  // 剩余行由应用的定时任务兜底
  let prevSearch = Infinity
  for (;;) {
    const remaining = await prisma.search_outbox.count()
    if (remaining === 0 || remaining >= prevSearch) {
      break
    }
    console.log(`搜索写出箱剩余 ${remaining} 行`)
    prevSearch = remaining
    await drainSearchOutbox()
  }
  let prevS3 = Infinity
  for (;;) {
    const remaining = await prisma.s3_deletion_outbox.count()
    if (remaining === 0 || remaining >= prevS3) {
      break
    }
    console.log(`S3 删除出箱剩余 ${remaining} 行`)
    prevS3 = remaining
    await drainS3DeletionOutbox()
  }

  console.log(
    `\n完成: 迁移 ${migrations.length} 条, 删除 ${deletions.length} 条, 重算 ${affectedPatchIds.size} 个条目`
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
