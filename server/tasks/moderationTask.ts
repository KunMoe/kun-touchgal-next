import cron from 'node-cron'
import sharp from 'sharp'
import { prisma } from '~/prisma'
import type { moderation_taskModel } from '~/prisma/generated/prisma/models'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { getKv, setKv } from '~/lib/redis'
import { getFileFromS3 } from '~/lib/s3'
import { toDependencyFailure } from '~/lib/resilience/failure'
import { withEncodeSlot } from '~/server/image/encodeLimit'
import { KUN_MODERATION_VERDICT_CACHE_KEY } from '~/config/redis'
import {
  MODERATION_BATCH_SIZE,
  MODERATION_CONCURRENCY,
  MODERATION_LEASE_SECONDS,
  MODERATION_LOCK_TTL_SECONDS,
  MODERATION_MAX_RETRY,
  MODERATION_S3_TIMEOUT_MS,
  MODERATION_VERDICT_CACHE_DURATION
} from '~/constants/moderation'
import type { ModerationTextType } from '~/constants/moderation'
import {
  MODERATION_PROMPT_VERSION,
  buildModerationUserMessage
} from '~/server/moderation/prompt'
import {
  ModerationConfigError,
  moderateImage,
  moderateText,
  moderationVerdictSchema
} from '~/server/moderation/ai'
import type {
  ModerationAiResult,
  ModerationVerdict
} from '~/server/moderation/ai'
import {
  applyModerationVerdict,
  markTaskManual
} from '~/server/moderation/apply'
import {
  filterBlacklistPatterns,
  hashModerationTexts,
  matchBlacklist,
  normalizeModerationText
} from '~/server/moderation/prefilter'
import type { ModerationBlacklistEntry } from '~/server/moderation/prefilter'
import {
  MODERATION_PAYLOAD_UNREADABLE,
  decodeModerationTask
} from '~/server/moderation/taskCodec'
import { buildAuditView } from '~/server/moderation/view'
import { withTaskLock } from './withTaskLock'

const MODERATION_LOCK_KEY = 'moderation:worker:lock'

// verdicts are cached per content_type: each type has a distinct system prompt,
// so a verdict from one type must never be replayed onto another. prompt 版本同样
// 入 key: 审核规则改动后旧裁决即失效, 不会被相同文本命中 (见 MODERATION_PROMPT_VERSION)
const verdictCacheKey = (contentType: ModerationTextType, hash: string) =>
  `${KUN_MODERATION_VERDICT_CACHE_KEY}:v${MODERATION_PROMPT_VERSION}:${contentType}:${hash}`

const getCachedVerdict = async (
  contentType: ModerationTextType,
  hash: string
): Promise<ModerationVerdict | null> => {
  // 缓存只是省一次调用: 读不到 (Redis 抖动) 按未命中处理, 不让这条任务为此失败
  let cached: string | null
  try {
    cached = await getKv(verdictCacheKey(contentType, hash))
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to read moderation verdict cache:', error)
    return null
  }
  if (!cached) {
    return null
  }
  try {
    const verdict = moderationVerdictSchema.safeParse(JSON.parse(cached))
    return verdict.success ? verdict.data : null
  } catch {
    return null
  }
}

const cacheVerdict = async (
  contentType: ModerationTextType,
  hash: string,
  verdict: ModerationVerdict
) => {
  await setKv(
    verdictCacheKey(contentType, hash),
    JSON.stringify(verdict),
    MODERATION_VERDICT_CACHE_DURATION
  ).catch((error) =>
    console.error('Failed to cache moderation verdict:', error)
  )
}

const applyAiResult = async (
  task: moderation_taskModel,
  result: ModerationAiResult
) => {
  const { verdict } = result
  await applyModerationVerdict({
    task,
    approved: verdict.pass,
    manual: verdict.manual === true,
    rejectCode: verdict.code,
    rejectReason: verdict.reason,
    verdict: verdict as Prisma.InputJsonValue,
    model: result.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut
  })
}

export const processTextTask = async (
  task: moderation_taskModel,
  blacklistEntries: ModerationBlacklistEntry[]
) => {
  const body = decodeModerationTask(task)
  if (!body || body.contentType === 'avatar') {
    await markTaskManual(task.id, MODERATION_PAYLOAD_UNREADABLE)
    return
  }
  // 落库的是原始段; 读者看到的形态 (渲染投影 + 原文) 在这里现算, 黑名单、缓存键、
  // 模型三者读的是同一份视图
  const view = await buildAuditView(body)

  const patterns = filterBlacklistPatterns(blacklistEntries, task.content_type)
  const blacklistHit = view
    .flatMap((segment) =>
      segment.source === undefined
        ? [segment.shown]
        : [segment.shown, segment.source]
    )
    .some((text) => matchBlacklist(normalizeModerationText(text), patterns))
  if (blacklistHit) {
    await applyModerationVerdict({
      task,
      approved: false,
      rejectCode: 'BLK',
      rejectReason: '命中黑名单',
      model: 'blacklist'
    })
    return
  }

  const { contentType } = body
  const userMessage = buildModerationUserMessage(view)
  // 每段固定取 (字段名, 读者所见, 原文) 三项, 与用户消息一一对应
  const hash = hashModerationTexts(
    view.flatMap((segment) => [
      segment.label,
      segment.shown,
      segment.source ?? ''
    ])
  )
  const cached = await getCachedVerdict(contentType, hash)
  if (cached) {
    await applyAiResult(task, {
      verdict: cached,
      model: 'cache',
      tokensIn: 0,
      tokensOut: 0
    })
    return
  }

  const result = await moderateText(contentType, userMessage)
  await cacheVerdict(contentType, hash, result.verdict)
  await applyAiResult(task, result)
}

export const processAvatarTask = async (task: moderation_taskModel) => {
  const body = decodeModerationTask(task)
  if (body?.contentType !== 'avatar') {
    await markTaskManual(task.id, MODERATION_PAYLOAD_UNREADABLE)
    return
  }
  let buffer: Buffer
  try {
    buffer = await getFileFromS3(
      body.payload.pendingKey,
      AbortSignal.timeout(MODERATION_S3_TIMEOUT_MS)
    )
  } catch (error) {
    throw toDependencyFailure('s3', error)
  }
  // vision APIs handle jpeg far more reliably than avif
  const jpeg = await withEncodeSlot(() =>
    sharp(buffer).jpeg({ quality: 85 }).toBuffer()
  )
  const result = await moderateImage(jpeg.toString('base64'))
  await applyAiResult(task, result)
}

// fetch 候选与逐行认领共用同一谓词: 待处理、已到重试时刻 (next_attempt)、租约为空或已
// 过期 (picked_at). 抽成工厂而非常量对象, 因两处各用自己的 now、共享 leaseStaleBefore;
// 认领时复用它二次校验, 避免并发下另一 worker 刚把该行退避推后时被本 worker 提前重试
const claimablePredicate = (
  now: Date,
  leaseStaleBefore: Date
): Prisma.moderation_taskWhereInput => ({
  status: 'pending',
  next_attempt: { lte: now },
  OR: [{ picked_at: null }, { picked_at: { lt: leaseStaleBefore } }]
})

// 处理单条任务: 成功即落裁决, 失败按重试/转人工记账. 各任务的 apply 是独立事务,
// 缓存与黑名单为共享只读, 因此可安全并发
const processTask = async (
  task: moderation_taskModel,
  blacklistEntries: ModerationBlacklistEntry[],
  leaseStaleBefore: Date
) => {
  // 非空 picked_at 说明这是在回收一个过期租约: 上次尝试既没走到结算 (会移出 pending)
  // 也没走到退避 (会清空 picked_at), 即上个 worker 是崩溃而非抛错. 计入 retry, 使反复
  // 崩溃 worker 的任务不会绕过 MAX_RETRY 被无限回收
  const isReclaim = task.picked_at !== null

  // 认领: 在昂贵的 AI/S3 调用前先给这一行盖上租约. 全局锁失效或部署期两个 cron 短暂
  // 并存时, 抢不到 (count 0) 的一方直接跳过, 同一任务永不被重复调用/重复扣费; 过期
  // 租约 (崩溃 worker 遗留) 可被回收
  const claim = await prisma.moderation_task.updateMany({
    where: { id: task.id, ...claimablePredicate(new Date(), leaseStaleBefore) },
    data: {
      picked_at: new Date(),
      ...(isReclaim ? { retry: { increment: 1 } } : {})
    }
  })
  if (claim.count === 0) {
    return
  }

  // 回收已耗尽重试预算: 该任务每次处理都让 worker 崩溃, 转人工而非再次重跑
  if (isReclaim && task.retry + 1 >= MODERATION_MAX_RETRY) {
    await markTaskManual(task.id, '多次处理未完成, 已转人工复核')
    return
  }

  try {
    if (task.content_type === 'avatar') {
      await processAvatarTask(task)
    } else {
      await processTextTask(task, blacklistEntries)
    }
  } catch (error) {
    if (error instanceof ModerationConfigError) {
      await markTaskManual(task.id, error.message)
      return
    }

    const retry = task.retry + 1
    if (retry >= MODERATION_MAX_RETRY) {
      await markTaskManual(task.id, `审核失败: ${String(error)}`)
    } else {
      // exponential backoff: 5s, 25s; 清租约使 next_attempt 到点即可被重新认领,
      // 无需干等租约自然过期. retry 为绝对写 (task.retry+1), 与回收时的 increment 落在
      // 同一值, 故"回收后又抛错"净 +1 而非双计 —— 勿把这里改成 increment
      await prisma.moderation_task.updateMany({
        where: { id: task.id, status: 'pending' },
        data: {
          retry,
          next_attempt: new Date(Date.now() + 5 ** retry * 1000),
          picked_at: null
        }
      })
    }
    console.error(`Moderation task ${task.id} attempt failed:`, error)
  }
}

// resource/rating 裁决在 apply 后处理会读改写 patch 级聚合 (resource→recalcPatchType
// 改 patch.type; rating→recomputePatchRatingStat 改 patch_rating_stat), 由 patch 级通告锁
// 串行化; 序列化 key 把同 patch 的这两类归同组 (组内串行、组间并发) 以降低锁争用与并发面:
// 同一 patch 串行、不同 patch 并行 (resource 与 rating 写不同聚合本不互斥, 合用 patch:<id>
// 键属保守简化); 旧任务无 patch_id 时降级按类型整体串行 (与改动前一致). avatar/bio 写同一
// user 行, 按 user 分组; 评论各自独立, 全并发
const serializationKey = (task: moderation_taskModel): string => {
  switch (task.content_type) {
    case 'resource':
    case 'rating':
      return task.patch_id !== null
        ? `patch:${task.patch_id}`
        : task.content_type
    case 'avatar':
    case 'bio':
      return `user:${task.user_id}`
    default:
      return `comment:${task.id}`
  }
}

// blacklist 只被这一个 cron 进程读、且极少变动, 进程内短 TTL 缓存即可, 免去每
// 15s tick 的全表重载 (与 getModerationConfig 同一权衡: 命中即拒的新规则最长延迟
// BLACKLIST_CACHE_DURATION_MS 生效)
const BLACKLIST_CACHE_DURATION_MS = 60 * 1000

let blacklistCache: {
  entries: ModerationBlacklistEntry[]
  expire: number
} | null = null

const getBlacklistEntries = async (): Promise<ModerationBlacklistEntry[]> => {
  const now = Date.now()
  if (blacklistCache && blacklistCache.expire > now) {
    return blacklistCache.entries
  }
  const entries = await prisma.moderation_blacklist.findMany({
    select: { pattern: true, content_types: true }
  })
  blacklistCache = { entries, expire: now + BLACKLIST_CACHE_DURATION_MS }
  return entries
}

// 导出只为测试: 生产里只由下面的 cron 任务在全局锁内调用
export const runModerationBatch = async () => {
  // 早于此刻的租约视为过期 (worker 崩溃), 连同未认领的行一起纳入候选; 认领时按行
  // 二次校验租约, 避免与仍在处理该行的其它 worker 撞车
  const leaseStaleBefore = new Date(
    Date.now() - MODERATION_LEASE_SECONDS * 1000
  )
  const tasks = await prisma.moderation_task.findMany({
    where: claimablePredicate(new Date(), leaseStaleBefore),
    // 按 next_attempt 升序取: 与 [status, next_attempt] 索引同序, Postgres 直接索引
    // 取前 N 免去额外 Sort. next_attempt 是范围条件, 其后的列 (如 created) 在索引里
    // 不构成有序, 故加复合索引也消不掉排序; 换排序键才是零成本解. 未重试任务
    // next_attempt 默认等于 created, FIFO 不变, 重试任务则按就绪时刻公平排队
    orderBy: { next_attempt: 'asc' },
    take: MODERATION_BATCH_SIZE
  })
  if (!tasks.length) {
    return
  }

  // blacklist 仅文本任务需要: 纯头像批跳过查询, 其余走进程内缓存
  const needsBlacklist = tasks.some((task) => task.content_type !== 'avatar')
  const blacklistEntries = needsBlacklist ? await getBlacklistEntries() : []

  // 把会相互竞态的任务归到同组 (组内串行), 再以有界并发处理各组: 一次慢的 vision
  // 调用不再阻塞排在其后的缓存/文本裁决. 批次只取一次, 并发 worker 通过 cursor++
  // 各领一组, 永不重复处理同一行
  const groups = new Map<string, moderation_taskModel[]>()
  for (const task of tasks) {
    const key = serializationKey(task)
    const group = groups.get(key)
    if (group) {
      group.push(task)
    } else {
      groups.set(key, [task])
    }
  }
  const groupList = [...groups.values()]

  let cursor = 0
  const runWorker = async () => {
    let index: number
    while ((index = cursor++) < groupList.length) {
      for (const task of groupList[index]) {
        await processTask(task, blacklistEntries, leaseStaleBefore)
      }
    }
  }
  // allSettled 而非 all: 即便某 worker 因记账写库失败而 reject, 也必须等其余 worker
  // 全部结束再返回——否则 withTaskLock 会在后台 worker 仍运行时释放锁, 与下批重叠
  const workerCount = Math.min(MODERATION_CONCURRENCY, groupList.length)
  const results = await Promise.allSettled(
    Array.from({ length: workerCount }, runWorker)
  )
  // worker 仅在记账写库失败时 reject (业务错误已在 processTask 内消化并记录);
  // 补记 rejected, 否则 DB 故障会让整批静默失败、排障无迹
  for (const result of results) {
    if (result.status === 'rejected') {
      console.error('Moderation worker crashed:', result.reason)
    }
  }
}

export const moderationTask = cron.createTask('*/15 * * * * *', async () => {
  await withTaskLock(
    {
      key: MODERATION_LOCK_KEY,
      ttlSeconds: MODERATION_LOCK_TTL_SECONDS,
      taskName: 'moderationTask'
    },
    runModerationBatch
  ).catch((error) => {
    console.error('Error running moderation batch:', error)
  })
})
