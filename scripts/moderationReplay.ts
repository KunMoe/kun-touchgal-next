/* eslint-disable no-console -- 命令行工具, 进度与汇总直接打到终端 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma } from '~/prisma/index'
import { MODERATION_TEXT_CONTENT_TYPE } from '~/constants/moderation'
import type { ModerationTextType } from '~/constants/moderation'
import {
  ModerationConfigError,
  moderateText,
  requestChatCompletion
} from '~/server/moderation/ai'
import type { ModerationVerdict } from '~/server/moderation/ai'
import { buildModerationUserMessage } from '~/server/moderation/prompt'
import {
  RESOURCE_LINK_FIELD_POLICY,
  bioSubject,
  commentSubject,
  ratingSubject,
  resourceSubject
} from '~/server/moderation/subject'
import type { ModerationSubject } from '~/server/moderation/subject'
import { decodeModerationTask } from '~/server/moderation/taskCodec'
import { buildAuditView } from '~/server/moderation/view'
import {
  LEGACY_TEXT_SYSTEM_PROMPT,
  legacyUserMessage
} from './moderationReplayLegacy'

// 新封装 (JSON 分段 + prompt v3) 的上线闸门: 离线回放。
//
// 取近期的文本审核任务, 对同一份原文分别用旧封装与新封装各调一次模型, 对比裁决。
// 对数据库只读 (全部是 findMany); 会调用真实模型并消耗 token, 每个样本两次调用。
// 不要改用全局 dryRun 开关做对照 —— 那会关掉全站拦截。
//
//   pnpm moderation:replay --limit 200
//   pnpm moderation:replay --limit 50 --types comment,resource --since 2026-10-01
//   pnpm moderation:replay --limit 20 --dry-run     只写出两侧输入, 不调模型
//   pnpm moderation:replay --limit 200 --without-links
//       新侧不带链接 / 提取码 / 解压码: 旧封装从不送审这三个字段, 带上它们时
//       「换封装」与「多审了三个字段」两种影响会混在一起; 两种方式各跑一次即可分开看
//
// 逐条结果写入 docs/tmp/moderation-replay/<时间>.jsonl, 终端打印分歧汇总

type Outcome = 'pass' | 'reject' | 'manual' | 'error'

interface Sample {
  taskId: number
  contentType: ModerationTextType
  // 历史任务当时的结论, 仅供参考: 当时的内容与模型都可能和现在不同
  recordedStatus: string
  subject: ModerationSubject
}

const readArgs = () => {
  const args = process.argv.slice(2)
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const types = (valueOf('--types')?.split(',') ??
    MODERATION_TEXT_CONTENT_TYPE) as ModerationTextType[]
  const unknown = types.filter(
    (type) => !MODERATION_TEXT_CONTENT_TYPE.includes(type)
  )
  if (unknown.length) {
    throw new Error(`未知的内容类型: ${unknown.join(', ')}`)
  }
  const since = valueOf('--since')
  return {
    limit: Number(valueOf('--limit') ?? 200),
    concurrency: Number(valueOf('--concurrency') ?? 4),
    since: since ? new Date(since) : undefined,
    types,
    dryRun: args.includes('--dry-run'),
    withoutLinks: args.includes('--without-links')
  }
}

const LINK_LABELS: string[] = Object.values(RESOURCE_LINK_FIELD_POLICY).flatMap(
  (policy) => (typeof policy === 'string' ? [] : [policy.label])
)
// 多条链接的字段名带序号 (「链接 2」)
const isLinkSegment = (label: string) =>
  LINK_LABELS.includes(label.replace(/ \d+$/, ''))

// 新任务的载荷里就是用户提交的原始段; 引入主体之前的旧任务只存了降噪后的文本,
// 原文要回内容表取 (内容已删除或签名任务没有暂存值时放弃该样本)
const loadSubject = async (
  task: {
    content_type: string
    content_id: number | null
    payload: unknown
  },
  withoutLinks: boolean
): Promise<ModerationSubject | null> => {
  const body = decodeModerationTask(task)
  if (!body || body.contentType === 'avatar') {
    return null
  }
  const isRaw =
    typeof task.payload === 'object' &&
    task.payload !== null &&
    'v' in task.payload
  if (isRaw) {
    return {
      contentType: body.contentType,
      segments: withoutLinks
        ? body.segments.filter((segment) => !isLinkSegment(segment.label))
        : body.segments
    }
  }

  const id = task.content_id ?? 0
  switch (body.contentType) {
    case 'comment': {
      const row = await prisma.patch_comment.findUnique({
        where: { id },
        select: { content: true }
      })
      return row && commentSubject(row.content)
    }
    case 'rating': {
      const row = await prisma.patch_rating.findUnique({
        where: { id },
        select: { short_summary: true }
      })
      return row && ratingSubject(row.short_summary)
    }
    case 'resource': {
      const row = await prisma.patch_resource.findUnique({
        where: { id },
        select: {
          name: true,
          note: true,
          model_name: true,
          links: {
            orderBy: { sort_order: 'asc' },
            select: {
              storage: true,
              content: true,
              size: true,
              code: true,
              password: true
            }
          }
        }
      })
      return (
        row &&
        resourceSubject({
          name: row.name,
          note: row.note,
          modelName: row.model_name,
          links: withoutLinks ? [] : row.links
        })
      )
    }
    case 'bio':
      return body.bio ? bioSubject(body.bio) : null
  }
}

const collectSamples = async (options: ReturnType<typeof readArgs>) => {
  const samples: Sample[] = []
  const seen = new Set<string>()
  let cursor: number | undefined

  while (samples.length < options.limit) {
    const tasks = await prisma.moderation_task.findMany({
      where: {
        content_type: { in: options.types },
        status: { in: ['approved', 'rejected', 'manual'] },
        ...(options.since ? { created: { gte: options.since } } : {}),
        ...(cursor === undefined ? {} : { id: { lt: cursor } })
      },
      orderBy: { id: 'desc' },
      take: 200,
      select: {
        id: true,
        content_type: true,
        content_id: true,
        payload: true,
        status: true
      }
    })
    if (!tasks.length) {
      break
    }
    for (const task of tasks) {
      cursor = task.id
      const subject = await loadSubject(task, options.withoutLinks)
      if (!subject || !subject.segments.length) {
        continue
      }
      // 同一份原文只回放一次 (编辑、重试会产生多条任务)
      const key = JSON.stringify(subject)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      samples.push({
        taskId: task.id,
        contentType: subject.contentType,
        recordedStatus: task.status,
        subject
      })
      if (samples.length >= options.limit) {
        break
      }
    }
  }
  return samples
}

const outcomeOf = (verdict: ModerationVerdict): Outcome =>
  verdict.manual ? 'manual' : verdict.pass ? 'pass' : 'reject'

const judge = async (
  call: () => Promise<{ verdict: ModerationVerdict }>
): Promise<{
  outcome: Outcome
  verdict?: ModerationVerdict
  error?: string
}> => {
  try {
    const { verdict } = await call()
    return { outcome: outcomeOf(verdict), verdict }
  } catch (error) {
    // 配置缺失不是某个样本的问题, 直接终止整次回放
    if (error instanceof ModerationConfigError) {
      throw error
    }
    return { outcome: 'error', error: String(error) }
  }
}

const main = async () => {
  const options = readArgs()
  // 送审视图要渲染 markdown; 渲染缓存连的是 Redis, esno 脚本里碰 Redis 连接会挂住。
  // 缓存是否启用在每次渲染时才读环境变量, 所以在发起任何渲染之前关掉即可
  // (.env 已由 prisma 模块读入)
  delete process.env.REDIS_HOST
  delete process.env.REDIS_PORT

  const samples = await collectSamples(options)
  console.log(
    `[replay] 样本 ${samples.length} 条 (上限 ${options.limit}), 类型 ${options.types.join(',')}` +
      (options.dryRun
        ? ', dry-run 不调模型'
        : `, 将调用模型 ${samples.length * 2} 次`)
  )

  const model = process.env.MODERATION_AI_TEXT_MODEL ?? ''
  const reasoningEffort = process.env.MODERATION_AI_TEXT_REASONING_EFFORT
  const rows: Record<string, unknown>[] = []
  let cursor = 0
  const worker = async () => {
    let index: number
    while ((index = cursor++) < samples.length) {
      const sample = samples[index]
      const oldInput = legacyUserMessage(sample.subject)
      const newInput = buildModerationUserMessage(
        await buildAuditView(sample.subject)
      )
      if (options.dryRun) {
        rows[index] = { ...sample, oldInput, newInput }
        continue
      }
      const [oldSide, newSide] = await Promise.all([
        judge(() =>
          requestChatCompletion(
            model,
            [
              {
                role: 'system',
                content: LEGACY_TEXT_SYSTEM_PROMPT[sample.contentType]
              },
              { role: 'user', content: oldInput }
            ],
            reasoningEffort
          )
        ),
        judge(() => moderateText(sample.contentType, newInput))
      ])
      rows[index] = {
        taskId: sample.taskId,
        contentType: sample.contentType,
        recordedStatus: sample.recordedStatus,
        agree: oldSide.outcome === newSide.outcome,
        old: oldSide,
        new: newSide,
        oldInput,
        newInput
      }
      if ((index + 1) % 20 === 0) {
        console.log(`[replay] ${index + 1}/${samples.length}`)
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, worker)
  )

  const directory = join(process.cwd(), 'docs', 'tmp', 'moderation-replay')
  mkdirSync(directory, { recursive: true })
  const file = join(
    directory,
    `${new Date().toISOString().replace(/[:.]/g, '-')}${options.dryRun ? '-dry-run' : ''}.jsonl`
  )
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  console.log(`[replay] 逐条结果: ${file}`)
  if (options.dryRun) {
    return
  }

  // 汇总: 每种内容类型下「旧结论 → 新结论」的计数。重点看 pass → reject (新封装更严,
  // 可能误伤) 与 reject → pass (新封装更松, 可能漏放) 两格
  const summary: Record<string, Record<string, number>> = {}
  for (const row of rows) {
    const type = row.contentType as string
    const transition = `${(row.old as { outcome: Outcome }).outcome} → ${(row.new as { outcome: Outcome }).outcome}`
    summary[type] ??= {}
    summary[type][transition] = (summary[type][transition] ?? 0) + 1
  }
  console.log('[replay] 旧封装 → 新封装 的裁决迁移:')
  console.table(summary)
  const disagreements = rows.filter((row) => !row.agree)
  console.log(
    `[replay] 一致 ${rows.length - disagreements.length} / ${rows.length}; 分歧 ${disagreements.length} 条的 taskId: ${disagreements
      .map((row) => row.taskId)
      .join(', ')}`
  )
}

main()
  .catch((error) => {
    console.error('[replay] fatal:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
