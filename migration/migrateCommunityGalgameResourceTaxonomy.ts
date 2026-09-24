// 一次性脚本：把社区账号 (user_id != 1) 的 galgame 下载资源从旧分类词表迁移到
// 872d5b9 引入的新词表 (galgame section 只允许 game/audio/image/video/other)。
// 与官方脚本 (migrateOfficialGalgameResourceTaxonomy.ts) 的差异：
// - 规则表覆盖全部社区组合 (精确规则 R1-R14 + 泛化拆解 G-*), 见 planResource；
// - type 含 patch/tool/notice 的资源直接删除 (R15, 复刻 delete.ts 语义但不扣萌萌点)；
// - type 为纯 {other} 的资源由 AI 分流为 音声/图片CG/视频, 判不出兜底 other (R7)；
// - 社区链接几乎全是外部网盘 (storage=user), 拿不到文件名, 仅从 s3 链接提取；
// - 全部 status (0/1/2/3) 一并迁移, 隐藏/待审核资源解除后词表须一致。
// 用法：pnpm esno migration/migrateCommunityGalgameResourceTaxonomy.ts [--dry-run] [--limit N]
//   --dry-run 只跑判定、写缓存与报告, 不写库不删除
//   --limit N 只处理前 N 条 (按 id 升序), 用于抽查
// 幂等：迁移后 type 已是新词表, 再跑会被判为 done 跳过；纯 {other} 行新旧词表同名,
// 重跑会经缓存重判得到同一结果并写入同值, 无害。删除行重跑时已不存在。
// 注意：三段 system prompt 任一文案改动都必须删除 cache.json 重判, 否则沿用旧判定。
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
  SUPPORTED_EMULATOR_TYPE
} from '~/constants/resource'

const OFFICIAL_USER_ID = 1
const SECTION = 'galgame'
const NEW_GALGAME_TYPES = RESOURCE_SECTION_TYPE_MAP.galgame

// 社区端点单次调用延迟高 (推理模型 ~15s), 需要更高并发才能在可接受时间内跑完;
// 并发上调后请求间隔相应收紧
const FETCH_CONCURRENCY = 32
const REQUEST_INTERVAL_MS = 60

const AI_MODEL = 'deepseek-v4-flash'
// 端点排队时单次调用可达 100s+, 超时放宽避免成批假失败。
// 使用 stream: true 规避 Cloudflare 免费版 ~100s 首字节超时 (504):
// 推理模型的 reasoning delta 通常秒级开始输出, 首字节一到 CF 便不再掐流;
// 超时语义随之从「整次调用」改为「相邻 chunk 最大间隔」, 长思考任务不再被误杀
const AI_CHUNK_IDLE_TIMEOUT_MS = 240 * 1000
const AI_ATTEMPTS = 3
const AI_NOTE_MAX_LENGTH = 500

const UPDATE_CHUNK_SIZE = 1000

const CACHE_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migrateCommunityGalgameResourceTaxonomy.cache.json'
)
const REPORT_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migrateCommunityGalgameResourceTaxonomy.report.md'
)
const BACKUP_FILE = path.resolve(
  process.cwd(),
  'migration/backup/migrateCommunityGalgameResourceTaxonomy.backup.json'
)

// P1: 模拟器判定 prompt (emu-type 与 apk-or-emu 规则共用), 源自官方脚本版本并增加证据权重规则
const AI_EMU_PROMPT = `你是 Galgame 资源分类助手。根据资源的标题、备注与网盘文件名，判断该安卓资源是「模拟器资源」「直装 APK」还是无法确定。

模拟器型号代号映射（输出必须使用左侧代号）：
- krkr: KR、KRKR、吉里吉里、KiriKiri、krkr2、文件名以 .xp3 结尾
- ons: ONS、ONScripter
- winlator: Winlator
- joiplay: Joi、JoiPlay
- tyranor_artemis: TY、Ty、Tyranor、AR、Ar、Artemis
- gaishi: 盖世、盖世模拟器
- other: 明确出现「模拟器」字样但型号不在上表中

证据权重：标题 > 网盘文件名 > 备注。用户常在备注中复制粘贴与资源本身无关的介绍文案，备注里提到的模拟器信息可能并不反映实际资源。判断必须以标题为主要依据，备注仅作辅助；仅出现在备注中、标题与文件名均无佐证的型号不得判定。

判断规则：
1. 仅当标题/备注/文件名中明确出现模拟器字样、型号或型号简写时，才判定为模拟器。
2. 文件名以 .xp3 结尾同样算明确证据，直接判定为 krkr（.xp3 是 KiriKiri 的封包格式）。
3. 一个资源可能同时适配多个模拟器：对每个型号分别判断，把有明确证据的型号代号全部放进 t 数组（按表中顺序），禁止输出没有证据的型号。
4. 仅当明确出现「直装」字样，或文件名以 .apk 结尾时，才判定为直装。
5. 一个资源可能同时包含模拟器资源与直装 APK（例如网盘里既有 .xp3 又有 .apk，或标题同时写了「直装」与型号字样）：模拟器证据与直装证据同时存在时输出 both，并在 t 中给出有证据的型号。
6. 除第 2 条外，没有明确证据时一律输出 uncertain，禁止根据游戏名称或引擎知识猜测。

只输出 JSON，禁止输出任何其他文本：
{"k":"emulator","t":["<型号代号>",...]} 或 {"k":"apk"} 或 {"k":"both","t":["<型号代号>",...]} 或 {"k":"uncertain"}`

// P-platform: 旧组合只有语言/手机标记 (R13/G-lang), 平台三选一由 AI 分流
const AI_PLATFORM_PROMPT = `你是 Galgame 资源分类助手。根据资源的标题、备注、网盘文件名与上传者当年选择的原分类/原平台，判断该资源的目标平台是「Windows」「Android 直装 APK」「Android 模拟器」还是无法确定。

模拟器型号代号映射（判定为模拟器时，输出必须使用左侧代号）：
- krkr: KR、KRKR、吉里吉里、KiriKiri、krkr2、文件名以 .xp3 结尾
- ons: ONS、ONScripter
- winlator: Winlator
- joiplay: Joi、JoiPlay
- tyranor_artemis: TY、Ty、Tyranor、AR、Ar、Artemis
- gaishi: 盖世、盖世模拟器
- other: 明确出现「模拟器」字样但型号不在上表中

证据权重：标题 > 网盘文件名 > 备注。用户常在备注中复制粘贴与资源本身无关的介绍文案，备注中的平台/模拟器信息可能并不反映实际资源。判断必须以标题为主要依据，备注仅作辅助；仅出现在备注中的证据不足以单独判定平台或型号。

判断规则：
1. 仅当出现明确证据时才下判断：PC、电脑、Windows 或文件名以 .exe 结尾指向 windows；「直装」字样或文件名以 .apk 结尾指向 apk；模拟器字样、型号或型号简写指向 emulator。
2. 原分类与原平台是上传者当年的选择，可作为佐证：原平台仅含 windows 且无相反证据时可判 windows；原平台含 android 时优先在 apk 与 emulator 之间判断。
3. 文件名以 .xp3 结尾判定为 emulator 且型号为 krkr。
4. 判定为 emulator 时，把有明确证据的型号代号全部放进 t 数组；若确定是模拟器但型号不明，t 输出 ["other"]。
5. 证据不足时一律输出 uncertain，禁止根据游戏名称或引擎知识猜测。

只输出 JSON，禁止输出任何其他文本：
{"k":"windows"} 或 {"k":"apk"} 或 {"k":"emulator","t":["<型号代号>",...]} 或 {"k":"uncertain"}`

// P-content: 纯 {other} 资源分流为 音声/图片CG/视频, 判不出兜底 other (无 uncertain)
const AI_CONTENT_PROMPT = `你是 Galgame 资源分类助手。根据资源的标题、备注与网盘文件名，判断该资源属于「音声」「图片CG」「视频」中的哪一类。

证据权重：标题 > 网盘文件名 > 备注。用户常在备注中复制粘贴与资源本身无关的介绍文案，备注中的内容字样可能并不反映实际资源。判断必须以标题为主要依据，备注仅作辅助。

判断规则：
1. audio (音声): 出现 音声、ASMR、ボイス、DLsite、RJ号（如 RJ123456）、Drama CD、广播剧 等字样，或文件名以 .mp3/.wav/.flac/.m4a/.ogg 结尾。
2. image (图片CG): 出现 CG、CG集、原画、立绘、壁纸、扫图、画集、图包 等字样，或文件名以 .jpg/.png/.webp 结尾。
3. video (视频): 出现 PV、OP、ED、动画、演示、实况、录像 等字样，或文件名以 .mp4/.mkv/.avi/.mov 结尾。
4. 无法明确归入以上三类时输出 other，禁止猜测。

只输出 JSON，禁止输出任何其他文本：
{"k":"audio"} 或 {"k":"image"} 或 {"k":"video"} 或 {"k":"other"}`

// ---------------------------------------------------------------------------
// 决策纯函数 (可单测, 不碰网络与数据库)
// ---------------------------------------------------------------------------

// 三段 prompt 对应的判定种类, 也是缓存条目的命中条件 (kind 不同视为未缓存)
export type AiKind = 'p1' | 'platform' | 'content'

const SYSTEM_PROMPT_BY_KIND: Record<AiKind, string> = {
  p1: AI_EMU_PROMPT,
  platform: AI_PLATFORM_PROMPT,
  content: AI_CONTENT_PROMPT
}

const OLD_TYPES = [
  'pc',
  'chinese',
  'mobile',
  'emulator',
  'row',
  'app',
  'patch',
  'tool',
  'notice',
  'other'
]
const DELETE_TYPES = ['patch', 'tool', 'notice']
const PLATFORM_FLAGS = ['pc', 'mobile', 'app', 'emulator']

export const setKey = (values: string[]) =>
  [...new Set(values)].sort().join(',')

// platform 为 'keep' 表示不改动该字段 (纯 PC 组合要保住已有 macos/linux 选择);
// ai=emu-type 时 platform 是最终值, ai=apk-or-emu 时是基础集 (AI 再并入 apk/emulator)
export interface MigrationSpec {
  rule: string
  platform: 'keep' | string[]
  ai: 'emu-type' | 'apk-or-emu' | 'platform' | null
}

export type Plan =
  | { kind: 'delete' }
  | { kind: 'content' }
  | { kind: 'done' }
  | { kind: 'edge'; reason: string }
  | { kind: 'spec'; spec: MigrationSpec }

// 用户给定的精确规则 (旧 type 组合去重排序后匹配)。R7 (纯 other) 与 R15 (删除)
// 在 planResource 里前置分支, 不进此表
const SPEC_BY_TYPE_KEY: Record<string, MigrationSpec> = {
  'chinese,pc': { rule: 'R1', platform: 'keep', ai: null },
  'pc,row': { rule: 'R2', platform: 'keep', ai: null },
  'app,chinese,mobile': { rule: 'R3', platform: ['apk'], ai: null },
  'app,mobile,row': { rule: 'R3', platform: ['apk'], ai: null },
  'chinese,emulator,mobile': {
    rule: 'R4',
    platform: ['emulator'],
    ai: 'emu-type'
  },
  'emulator,mobile,row': { rule: 'R4', platform: ['emulator'], ai: 'emu-type' },
  'chinese,mobile': { rule: 'R5', platform: [], ai: 'apk-or-emu' },
  'chinese,emulator,mobile,pc': {
    rule: 'R6',
    platform: ['windows', 'emulator'],
    ai: 'emu-type'
  },
  pc: { rule: 'R8', platform: 'keep', ai: null },
  'app,chinese,emulator,mobile,pc': {
    rule: 'R9',
    platform: ['windows', 'apk', 'emulator'],
    ai: 'emu-type'
  },
  'app,chinese,mobile,pc': {
    rule: 'R10',
    platform: ['windows', 'apk'],
    ai: null
  },
  'chinese,emulator': { rule: 'R11', platform: ['emulator'], ai: 'emu-type' },
  emulator: { rule: 'R11', platform: ['emulator'], ai: 'emu-type' },
  'emulator,mobile': { rule: 'R11', platform: ['emulator'], ai: 'emu-type' },
  'chinese,emulator,pc': {
    rule: 'R12',
    platform: ['windows', 'emulator'],
    ai: 'emu-type'
  },
  chinese: { rule: 'R13', platform: [], ai: 'platform' },
  mobile: { rule: 'R13', platform: [], ai: 'platform' },
  app: { rule: 'R14', platform: ['apk'], ai: null },
  'app,chinese': { rule: 'R14', platform: ['apk'], ai: null },
  'app,mobile': { rule: 'R14', platform: ['apk'], ai: null }
}

export const planResource = (type: string[]): Plan => {
  const key = setKey(type)
  const set = new Set(type)

  // R15 优先级最高: 组合里混进 patch/tool/notice 即整条删除
  if (DELETE_TYPES.some((t) => set.has(t))) {
    return { kind: 'delete' }
  }
  // 纯 {other} 新旧词表同名, 必须先于 done 判定, 交给 AI 分流 (R7)
  if (key === 'other') {
    return { kind: 'content' }
  }
  if (type.length > 0 && type.every((t) => NEW_GALGAME_TYPES.includes(t))) {
    return { kind: 'done' }
  }

  const exact = SPEC_BY_TYPE_KEY[key]
  if (exact) {
    return { kind: 'spec', spec: exact }
  }
  // other 与游戏标记混杂 (如 app,chinese,mobile,other) 内容不明, 进边角报告
  if (set.has('other')) {
    return { kind: 'edge', reason: `含 other 的混合组合 {${key}}` }
  }
  if (![...set].every((t) => OLD_TYPES.includes(t))) {
    return { kind: 'edge', reason: `词表外的 type 值 {${key}}` }
  }

  // 泛化拆解 (用户裁定): 表外的纯 {pc/mobile/app/emulator/chinese/row} 组合按
  // 标记拆解 —— pc→windows, app→apk, emulator→emulator(AI 判型号); chinese/row
  // 仅是语言标记直接去除; mobile 无 app/emulator 佐证时安卓形态未知, 交给 AI
  const flags = PLATFORM_FLAGS.filter((flag) => set.has(flag))
  if (flags.length === 0) {
    return {
      kind: 'spec',
      spec: { rule: 'G-lang', platform: [], ai: 'platform' }
    }
  }
  if (flags.length === 1 && flags[0] === 'pc') {
    return { kind: 'spec', spec: { rule: 'G-pc', platform: 'keep', ai: null } }
  }
  const base: string[] = []
  if (set.has('pc')) {
    base.push('windows')
  }
  if (set.has('app')) {
    base.push('apk')
  }
  if (set.has('emulator')) {
    return {
      kind: 'spec',
      spec: { rule: 'G-emu', platform: [...base, 'emulator'], ai: 'emu-type' }
    }
  }
  if (set.has('mobile') && !set.has('app')) {
    return {
      kind: 'spec',
      spec: { rule: 'G-mobile', platform: base, ai: 'apk-or-emu' }
    }
  }
  return { kind: 'spec', spec: { rule: 'G-flags', platform: base, ai: null } }
}

export const aiKindForPlan = (plan: Plan): AiKind | null => {
  if (plan.kind === 'content') {
    return 'content'
  }
  if (plan.kind !== 'spec' || plan.spec.ai === null) {
    return null
  }
  return plan.spec.ai === 'platform' ? 'platform' : 'p1'
}

export type AiVerdict =
  | { k: 'emulator'; t: string[] }
  | { k: 'apk' }
  | { k: 'both'; t: string[] }
  | { k: 'windows' }
  | { k: 'uncertain' }
  | { k: 'audio' }
  | { k: 'image' }
  | { k: 'video' }
  | { k: 'other' }

const emulatorTypesSchema = z
  .array(z.string())
  .nonempty()
  .refine((types) =>
    types.every((type) => SUPPORTED_EMULATOR_TYPE.includes(type))
  )
  .transform((types) => [...new Set(types)])

const verdictSchemaByKind: Record<AiKind, z.ZodType<AiVerdict>> = {
  p1: z.union([
    z.object({ k: z.literal('emulator'), t: emulatorTypesSchema }),
    z.object({ k: z.literal('apk') }),
    z.object({ k: z.literal('both'), t: emulatorTypesSchema }),
    z.object({ k: z.literal('uncertain') })
  ]),
  platform: z.union([
    z.object({ k: z.literal('windows') }),
    z.object({ k: z.literal('apk') }),
    z.object({ k: z.literal('emulator'), t: emulatorTypesSchema }),
    z.object({ k: z.literal('uncertain') })
  ]),
  content: z.union([
    z.object({ k: z.literal('audio') }),
    z.object({ k: z.literal('image') }),
    z.object({ k: z.literal('video') }),
    z.object({ k: z.literal('other') })
  ])
}

// 模型输出不可信: 围栏/非 JSON/枚举外取值一律降级, 由规则兜底, 而不是让脚本抛错
// 中断 (与「AI 调用失败」区分开)。content 类的兜底就是 other (用户规则 7)
export const parseAiVerdict = (kind: AiKind, raw: string): AiVerdict => {
  const fallback: AiVerdict =
    kind === 'content' ? { k: 'other' } : { k: 'uncertain' }
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return fallback
  }

  const verdict = verdictSchemaByKind[kind].safeParse(parsed)
  return verdict.success ? verdict.data : fallback
}

export type ReportBucket =
  | 'deleted'
  | 'edge-other-mix'
  | 'emu-unknown'
  | 'platform-uncertain'
  | 'content-fallback-other'
  | 'ai-failed'

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
  | { action: 'delete' }
  | {
      action: 'migrate'
      rule: string
      update: ResourceUpdate
      report?: ReportEntry
    }
  | { action: 'skip'; rule: string | null; report: ReportEntry }

const AI_FAILED_REPORT: ReportEntry = {
  bucket: 'ai-failed',
  reason: 'AI 判定调用失败'
}

// verdict 为 null 表示 AI 调用失败或未调用; 只有需要 AI 的规则会用到它
export const decideResource = (
  type: string[],
  verdict: AiVerdict | null
): Decision => {
  const plan = planResource(type)

  if (plan.kind === 'delete') {
    return { action: 'delete' }
  }
  if (plan.kind === 'done') {
    return { action: 'done' }
  }
  if (plan.kind === 'edge') {
    return {
      action: 'skip',
      rule: null,
      report: { bucket: 'edge-other-mix', reason: plan.reason }
    }
  }

  if (plan.kind === 'content') {
    if (!verdict) {
      return { action: 'skip', rule: 'R7', report: AI_FAILED_REPORT }
    }
    if (
      verdict.k === 'audio' ||
      verdict.k === 'image' ||
      verdict.k === 'video'
    ) {
      return { action: 'migrate', rule: 'R7', update: { type: [verdict.k] } }
    }
    return {
      action: 'migrate',
      rule: 'R7',
      update: { type: ['other'] },
      report: {
        bucket: 'content-fallback-other',
        reason: 'AI 无法归入音声/图片CG/视频, 兜底为其它'
      }
    }
  }

  const { spec } = plan
  if (spec.ai === null) {
    return {
      action: 'migrate',
      rule: spec.rule,
      update: {
        type: ['game'],
        ...(spec.platform === 'keep' ? {} : { platform: spec.platform })
      }
    }
  }
  if (!verdict) {
    return { action: 'skip', rule: spec.rule, report: AI_FAILED_REPORT }
  }

  if (spec.ai === 'emu-type') {
    // 原分类已声明是模拟器资源, 型号判不出也照常迁移, 填 other 并记报告供人工复核
    const platform = spec.platform as string[]
    if (verdict.k === 'emulator') {
      return {
        action: 'migrate',
        rule: spec.rule,
        update: { type: ['game'], platform, emulator_type: verdict.t }
      }
    }
    return {
      action: 'migrate',
      rule: spec.rule,
      update: { type: ['game'], platform, emulator_type: ['other'] },
      report: {
        bucket: 'emu-unknown',
        reason:
          verdict.k === 'apk' || verdict.k === 'both'
            ? 'AI 判为直装, 与原模拟器分类矛盾, 型号未知'
            : 'AI 无法确定模拟器型号'
      }
    }
  }

  if (spec.ai === 'apk-or-emu') {
    // 旧组合只说明是手机资源, 模拟器/直装/两者兼有由 AI 分流, 判不出则整行不迁移
    const base = spec.platform as string[]
    if (verdict.k === 'emulator' || verdict.k === 'both') {
      const platform =
        verdict.k === 'both'
          ? [...base, 'apk', 'emulator']
          : [...base, 'emulator']
      return {
        action: 'migrate',
        rule: spec.rule,
        update: {
          type: ['game'],
          platform,
          emulator_type: verdict.t
        }
      }
    }
    if (verdict.k === 'apk') {
      return {
        action: 'migrate',
        rule: spec.rule,
        update: { type: ['game'], platform: [...base, 'apk'] }
      }
    }
    return {
      action: 'skip',
      rule: spec.rule,
      report: {
        bucket: 'platform-uncertain',
        reason: 'AI 无法确定是模拟器资源还是直装 APK'
      }
    }
  }

  // spec.ai === 'platform': 平台三选一, 判不出则整行不迁移
  if (verdict.k === 'windows') {
    return {
      action: 'migrate',
      rule: spec.rule,
      update: { type: ['game'], platform: ['windows'] }
    }
  }
  if (verdict.k === 'apk') {
    return {
      action: 'migrate',
      rule: spec.rule,
      update: { type: ['game'], platform: ['apk'] }
    }
  }
  if (verdict.k === 'emulator') {
    return {
      action: 'migrate',
      rule: spec.rule,
      update: {
        type: ['game'],
        platform: ['emulator'],
        emulator_type: verdict.t
      }
    }
  }
  return {
    action: 'skip',
    rule: spec.rule,
    report: {
      bucket: 'platform-uncertain',
      reason: 'AI 无法确定目标平台'
    }
  }
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

// 原分类/原平台仅提供给 platform 判定作佐证 (上传者当年的选择), 其余判定不带,
// 避免污染「仅凭明确证据」的判定规则
export const buildAiUserContent = (
  name: string,
  note: string,
  fileNames: string[],
  hints?: { type: string[]; platform: string[] }
) =>
  [
    `标题: ${name || '(空)'}`,
    `备注: ${note.slice(0, AI_NOTE_MAX_LENGTH) || '(空)'}`,
    ...(hints
      ? [
          `原分类: {${setKey(hints.type)}}`,
          `原平台: ${setKey(hints.platform) ? `{${setKey(hints.platform)}}` : '(空)'}`
        ]
      : []),
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

// 端点形态仿 server/moderation/ai.ts, 但不复用该模块 (它耦合审核语义与模型 env)。
// 流式读取: 拼接 choices[0].delta.content; 推理模型的 reasoning_content 丢弃。
// 流中途断开/解析失败一律 throw 走重试, 不保留半截结果 (更不会进缓存)
const requestAiRaw = async (
  kind: AiKind,
  userContent: string
): Promise<string> => {
  const baseUrl = process.env.MODERATION_AI_BASE_URL!.replace(/\/+$/, '')
  const controller = new AbortController()
  // 相邻 chunk 空闲超时: 每次收到数据就续期, 端点长时间无输出才 abort
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
          { role: 'system', content: SYSTEM_PROMPT_BY_KIND[kind] },
          { role: 'user', content: userContent }
        ],
        temperature: 0,
        // 与 moderation 取齐: 推理模型的思考也计入输出 token, 上限过小会让正文为空
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
        // 跳过心跳注释/空行; data: [DONE] 直接忽略, 以流结束为准
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

// 只缓存 AI 调用成功的结果; kind 不同 (规则调整导致判定种类变化) 视为未缓存
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
  status: number
  user_id: number
  patch_id: number
  patch: { unique_id: string }
  links: { storage: string; content: string; hash: string; s3_key: string }[]
}

interface BackupState {
  updated: Record<string, { id: number; type: string[]; platform: string[] }>
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
        platform: row.platform
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
  // 排序使两次运行的报告可直接 diff
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

const RULE_ORDER = [
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
  'G-pc',
  'G-flags',
  'G-emu',
  'G-mobile',
  'G-lang'
]

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
      status: true,
      user_id: true,
      patch_id: true,
      patch: { select: { unique_id: true } },
      links: {
        select: { storage: true, content: true, hash: true, s3_key: true }
      }
    }
  })) as ResourceRow[]
  console.log(
    `扫描到 ${resources.length} 条资源${isDryRun ? ' (dry-run)' : ''}${limit ? ` (--limit ${limit})` : ''}`
  )

  // 阶段一: 对需要 AI 的资源判定, 结果写本地缓存供正式跑复用。社区链接几乎全是
  // 外部网盘, 文件名只能从 s3 链接的 URL 末段提取, 无网络抓取
  const aiTargets = resources.filter(
    (resource) => aiKindForPlan(planResource(resource.type)) !== null
  )
  const cache = readCache()
  const verdicts = new Map<number, AiVerdict | null>()
  let cacheHit = 0
  let processed = 0

  console.log(`需要 AI 判定的资源 ${aiTargets.length} 条`)
  await runPool(aiTargets, FETCH_CONCURRENCY, async (resource) => {
    const kind = aiKindForPlan(planResource(resource.type))!
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
          fileNames,
          kind === 'platform'
            ? { type: resource.type, platform: resource.platform }
            : undefined
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
    'edge-other-mix': [],
    'emu-unknown': [],
    'platform-uncertain': [],
    'content-fallback-other': [],
    'ai-failed': []
  }
  const ruleHits: Record<string, number> = {}
  let doneCount = 0

  for (const resource of resources) {
    const decision = decideResource(
      resource.type,
      verdicts.get(resource.id) ?? null
    )
    if (decision.action === 'done') {
      doneCount++
      // 已迁移的资源也算受影响: 若上次运行在「写资源」与「重算条目」之间中断, 重跑时
      // 这些资源全是 done, 不纳入就再也不会重算。recalcPatchType 幂等, 重复只是慢
      affectedPatchIds.add(resource.patch_id)
      continue
    }
    if (decision.action === 'delete') {
      deletions.push(resource)
      reportRows.deleted.push({
        resource,
        reason: `type 组合 {${setKey(resource.type)}} 含 patch/tool/notice${isDryRun ? ', 待删除' : ', 已删除'}`
      })
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
    ...RULE_ORDER.map(
      (rule) => [`　${rule} 命中`, ruleHits[rule] ?? 0] as [string, number]
    ),
    ['R15 删除', deletions.length],
    ['含 other 混合组合 (未迁移)', reportRows['edge-other-mix'].length],
    ['模拟器型号未知, 填 other (已迁移)', reportRows['emu-unknown'].length],
    ['平台无法确定 (未迁移)', reportRows['platform-uncertain'].length],
    ['R7 兜底 other (已迁移)', reportRows['content-fallback-other'].length],
    ['AI 调用失败 (未迁移)', reportRows['ai-failed'].length],
    ['受影响的游戏条目', affectedPatchIds.size]
  ] as [string, number][]

  const report = [
    '# 社区 galgame 资源分类迁移报告',
    '',
    `- 模式: ${isDryRun ? 'dry-run (未写库)' : '正式执行'}`,
    `- 生成时间: ${new Date().toISOString()}`,
    `- 范围: user_id <> ${OFFICIAL_USER_ID} AND section = '${SECTION}' (全部 status)${limit ? ` (--limit ${limit})` : ''}`,
    '',
    '## 概览',
    '',
    '| 项 | 数量 |',
    '|---|---|',
    ...overview.map(([label, value]) => `| ${label} | ${value} |`),
    '',
    renderReportSection(
      `R15 删除留档${isDryRun ? ' (dry-run, 未删除)' : ''}`,
      reportRows.deleted,
      siteUrl
    ),
    renderReportSection(
      '含 other 混合组合 (未迁移)',
      reportRows['edge-other-mix'],
      siteUrl
    ),
    renderReportSection(
      '模拟器型号未知, 已填 other (需人工复核)',
      reportRows['emu-unknown'],
      siteUrl
    ),
    renderReportSection(
      '平台无法确定 (未迁移)',
      reportRows['platform-uncertain'],
      siteUrl
    ),
    renderReportSection(
      'R7 兜底 other (已迁移, 仅供参考)',
      reportRows['content-fallback-other'],
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

  // 阶段四: R15 删除。逐条事务复刻 app/api/patch/resource/delete.ts 的删除语义
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
    console.log(`R15 删除完成: ${deletions.length} 条`)
  }

  // 阶段五: 写库。相同变更合并成 updateMany 批次
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
