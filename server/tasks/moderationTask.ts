import { prisma } from '~/prisma'
import type { moderation_taskModel } from '~/prisma/generated/prisma/models'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { getKv, setKv } from '~/lib/redis'
import { getFileFromS3 } from '~/lib/s3'
import {
  DependencyFailure,
  toDependencyFailure
} from '~/lib/resilience/failure'
import { transcodeTrustedAvifToJpeg } from '~/server/image/transcode'
import { KUN_MODERATION_VERDICT_CACHE_KEY } from '~/config/redis'
import {
  MODERATION_BREAKER,
  MODERATION_CONCURRENCY,
  MODERATION_LANE,
  MODERATION_LEASE_SECONDS,
  MODERATION_MAX_RETRY,
  MODERATION_S3_TIMEOUT_MS,
  MODERATION_SYSTEMATIC_DETECTION,
  MODERATION_VERDICT_CACHE_DURATION
} from '~/constants/moderation'
import type { ModerationLane, ModerationTextType } from '~/constants/moderation'
import { buildModerationUserMessage } from '~/server/moderation/prompt'
import { loadModerationPolicy } from '~/server/moderation/policy'
import type { ModerationPolicy } from '~/server/moderation/policy'
import {
  ModerationConfigError,
  moderateImage,
  moderateText,
  moderationVerdictSchema,
  requireVisionModel
} from '~/server/moderation/ai'
import type {
  ModerationAiResult,
  ModerationVerdict
} from '~/server/moderation/ai'
import { decideFailureAccounting } from '~/server/moderation/accounting'
import type { FailureAccounting } from '~/server/moderation/accounting'
import {
  applyModerationVerdict,
  markTaskManual
} from '~/server/moderation/apply'
import { createLaneBreaker } from '~/server/moderation/breaker'
import type {
  BreakerEvent,
  LaneBreaker,
  TaskFailureScope
} from '~/server/moderation/breaker'
import { publishModerationHealth } from '~/server/moderation/health'
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
import { defineScheduledJob } from '~/server/jobs/registry'

// verdicts are cached per content_type: each type has a distinct system prompt,
// so a verdict from one type must never be replayed onto another. 策略身份同样入 key
// (prompt 版本、文本模型、思考强度, 见 policy.ts): 任何一样变了旧裁决即失效, 不会被
// 相同文本命中
const verdictCacheKey = (
  policy: ModerationPolicy,
  contentType: ModerationTextType,
  hash: string
) =>
  `${KUN_MODERATION_VERDICT_CACHE_KEY}:p${policy.textId}:${contentType}:${hash}`

const getCachedVerdict = async (
  policy: ModerationPolicy,
  contentType: ModerationTextType,
  hash: string
): Promise<ModerationVerdict | null> => {
  // 缓存只是省一次调用: 读不到 (Redis 抖动) 按未命中处理, 不让这条任务为此失败
  let cached: string | null
  try {
    cached = await getKv(verdictCacheKey(policy, contentType, hash))
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
  policy: ModerationPolicy,
  contentType: ModerationTextType,
  hash: string,
  verdict: ModerationVerdict
) => {
  await setKv(
    verdictCacheKey(policy, contentType, hash),
    JSON.stringify(verdict),
    MODERATION_VERDICT_CACHE_DURATION
  ).catch((error) =>
    console.error('Failed to cache moderation verdict:', error)
  )
}

const applyAiResult = async (
  task: moderation_taskModel,
  result: ModerationAiResult,
  signal?: AbortSignal
) => {
  const { verdict } = result
  await applyModerationVerdict({
    signal,
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

// 处理一条任务的函数在「这条车道的依赖都答复了」的那一刻调用 laneHealthy: 文本车道
// 是模型给出了可用的裁决 (之后落库再失败是这条任务自己的事, 不是模型的), 头像车道
// 还要等落地时的存储复制做完。在本地就落定的任务 (黑名单、缓存、载荷不可读) 不调用它:
// 它们对依赖的状态什么也说明不了
type LaneHealthy = () => void

// signal: 中止时放弃在途的模型调用 (作业关停的宽限期满)
export const processTextTask = async (
  task: moderation_taskModel,
  blacklistEntries: ModerationBlacklistEntry[],
  policy: ModerationPolicy,
  laneHealthy: LaneHealthy = () => {},
  signal?: AbortSignal
) => {
  const body = decodeModerationTask(task)
  if (!body || body.contentType === 'avatar') {
    await markTaskManual(task.id, {
      kind: 'internal',
      reason: MODERATION_PAYLOAD_UNREADABLE
    })
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
  const cached = await getCachedVerdict(policy, contentType, hash)
  if (cached) {
    await applyAiResult(task, {
      verdict: cached,
      // 带上策略身份: 管理端看得出这条裁决是哪一套模型与 prompt 给的
      model: `cache:${policy.textId}`,
      tokensIn: 0,
      tokensOut: 0
    })
    return
  }

  const result = await moderateText(policy, contentType, userMessage, signal)
  laneHealthy()
  await cacheVerdict(policy, contentType, hash, result.verdict)
  await applyAiResult(task, result)
}

// signal: 中止时放弃在途的取图、模型调用与落地复制 (作业关停的宽限期满)
export const processAvatarTask = async (
  task: moderation_taskModel,
  policy: ModerationPolicy,
  laneHealthy: LaneHealthy = () => {},
  signal?: AbortSignal
) => {
  const body = decodeModerationTask(task)
  if (body?.contentType !== 'avatar') {
    await markTaskManual(task.id, {
      kind: 'internal',
      reason: MODERATION_PAYLOAD_UNREADABLE
    })
    return
  }
  // 没配视觉模型 (有意的部署方式) 的任务注定转人工: 先在这里抛出, 不去取图。否则存储的
  // 偶发失败会记到头像车道头上, 而这条车道永远等不到一次成功来复位
  requireVisionModel(policy)
  let buffer: Buffer
  try {
    buffer = await getFileFromS3(
      body.payload.pendingKey,
      AbortSignal.any([
        AbortSignal.timeout(MODERATION_S3_TIMEOUT_MS),
        ...(signal ? [signal] : [])
      ])
    )
  } catch (error) {
    throw toDependencyFailure('s3', error)
  }
  // vision APIs handle jpeg far more reliably than avif
  const jpeg = await transcodeTrustedAvifToJpeg(buffer)
  const result = await moderateImage(policy, jpeg.toString('base64'), signal)
  await applyAiResult(task, result, signal)
  laneHealthy()
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

const laneOf = (task: { content_type: string }): ModerationLane =>
  task.content_type === 'avatar' ? 'avatar' : 'text'

// worker 跨批次保留的状态: 每条车道一个熔断器, 观察多条任务之间失败的相关性
// (server/moderation/breaker.ts)。只活在这一个 cron 进程里, 进程重启即回到 closed ——
// 重启后依赖若仍不可用, 头几条任务会重新把它打开
export interface ModerationWorker {
  breakers: Record<ModerationLane, LaneBreaker>
}

export const createModerationWorker = (options: {
  systematic: 'log' | 'enforce'
}): ModerationWorker => {
  const createBreaker = (lane: ModerationLane) =>
    createLaneBreaker({
      ...MODERATION_BREAKER,
      systematic: options.systematic,
      // 探测任务的处理耗时受认领租约约束, 名额的占用期与它取同一个上界
      probeLeaseMs: MODERATION_LEASE_SECONDS * 1000,
      onEvent: (event: BreakerEvent) => {
        // 车道每次开合 (以及疑似系统性故障) 留一行可 grep 的日志
        // (pm2 logs | grep kun-moderation-breaker): 阈值在正常流量下有没有误开、
        // 每一轮故障持续了多久, 靠它回看
        // eslint-disable-next-line no-console
        console.warn(
          `[kun-moderation-breaker] ${JSON.stringify({ lane, ...event })}`
        )
      }
    })
  return {
    breakers: { text: createBreaker('text'), avatar: createBreaker('avatar') }
  }
}

const defaultWorker = createModerationWorker({
  systematic: MODERATION_SYSTEMATIC_DETECTION
})

const reportHealth = (worker: ModerationWorker) =>
  publishModerationHealth({
    at: Date.now(),
    lanes: {
      text: worker.breakers.text.snapshot(),
      avatar: worker.breakers.avatar.snapshot()
    }
  })

// 一次处理失败说明了什么范围的问题。范围只在调用依赖的边界上定 (ai.ts、S3 的调用点),
// 这里不从错误的样子去猜: 没带范围的错误一律是 internal。消息里留着错误的类名
// (与 toDependencyFailure 同一格式): 转人工原因靠它分辨是哪一层抛的
const describeFailure = (
  error: unknown
): { scope: TaskFailureScope; message: string; retryAfterMs: number | null } =>
  error instanceof DependencyFailure
    ? {
        scope: error.scope,
        message: error.message,
        retryAfterMs: error.retryAfterMs
      }
    : {
        scope: 'internal',
        message:
          error instanceof Error
            ? `${error.name === 'Error' ? '' : `${error.name}: `}${error.message}`
            : String(error),
        retryAfterMs: null
      }

// 把记账结论落库。推迟与重试都清租约, 使 next_attempt 到点即可被重新认领, 无需干等租约
// 自然过期。retry / defer_count 都是绝对写 (task 上的值 +1): retry 与回收时的 increment
// 落在同一值, 故「回收后又抛错」净 +1 而非双计 —— 勿改成 increment
const applyAccounting = async (taskId: number, decision: FailureAccounting) => {
  if (decision.action === 'manual') {
    await markTaskManual(taskId, {
      kind: decision.kind,
      reason: decision.reason
    })
    return
  }
  await prisma.moderation_task.updateMany({
    where: { id: taskId, status: 'pending' },
    data: {
      ...(decision.action === 'retry' ? { retry: decision.retry } : {}),
      ...(decision.action === 'defer' && decision.deferCount !== undefined
        ? { defer_count: decision.deferCount }
        : {}),
      failure_kind: decision.kind,
      next_attempt: decision.nextAttempt,
      picked_at: null
    }
  })
}

// 一条任务的处理上下文。同一轮取出的任务共用除 probe 之外的各项
interface TaskContext {
  // 这一轮用的审核策略: 每轮读一次环境变量, 同一轮的调用与缓存键同源
  policy: ModerationPolicy
  blacklistEntries: ModerationBlacklistEntry[]
  leaseStaleBefore: Date
  // 关停的宽限期满时中止: 在途的模型与存储调用随之放弃 (见 processTask 的 catch)
  cancelSignal: AbortSignal
  // 取任务时已经替它拿了车道的探测名额
  probe: boolean
}

// 关停的宽限期满、在途调用被中止: 不是这条内容的问题, 也不是依赖的, 不扣预算、不进熔断器。
// 清掉认领, 下一个进程立即就能重新取到它; 不清的话要等认领租约过期, 回收时还会被当成崩溃
// 扣一次 retry
const releaseClaim = (taskId: number) =>
  prisma.moderation_task.updateMany({
    where: { id: taskId, status: 'pending' },
    data: { picked_at: null }
  })

// 处理单条任务: 成功即落裁决, 失败按 accounting.ts 记账. 各任务的 apply 是独立事务,
// 缓存与黑名单为共享只读, 因此可安全并发。只有写库失败 (认领、记账、转人工) 才会抛出
const processTask = async (
  worker: ModerationWorker,
  task: moderation_taskModel,
  context: TaskContext
) => {
  const breaker = worker.breakers[laneOf(task)]

  // 车道门: 正在处理的其它任务可能刚把车道打开, 所以取任务时问过一次, 认领之前再问
  // 一次。不放行的任务留在 pending、不认领, 车道恢复后照常被取到
  const admission = context.probe ? 'probe' : breaker.admit()
  if (admission === 'blocked') {
    return
  }
  let holdsProbe = admission === 'probe'

  try {
    // 非空 picked_at 说明这是在回收一个过期租约: 上次尝试既没走到结算 (会移出 pending)
    // 也没走到退避 (会清空 picked_at), 即上个 worker 是崩溃而非抛错. 计入 retry, 使反复
    // 崩溃 worker 的任务不会绕过 MAX_RETRY 被无限回收
    const isReclaim = task.picked_at !== null

    // 认领: 在昂贵的 AI/S3 调用前先给这一行盖上租约. 锁键丢失或部署期两个 cron 短暂
    // 并存时, 抢不到 (count 0) 的一方直接跳过, 同一任务永不被重复调用/重复扣费; 过期
    // 租约 (崩溃 worker 遗留) 可被回收。抢不到说明这一行在取出之后刚被改过 (认领、退避
    // 或结算), 下一轮按同一谓词取不到它, 池不会在它身上空转
    const claim = await prisma.moderation_task.updateMany({
      where: {
        id: task.id,
        ...claimablePredicate(new Date(), context.leaseStaleBefore)
      },
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
      await markTaskManual(task.id, {
        kind: 'crash_loop',
        reason: '多次处理未完成, 已转人工复核'
      })
      return
    }

    // 依赖都答复了: 车道闭合。探测的结果由此了结; 之后这条任务再失败 (落库出错)
    // 是它自己的事, 按闭合的车道记账
    const laneHealthy = () => {
      breaker.recordSuccess()
      holdsProbe = false
    }
    try {
      if (task.content_type === 'avatar') {
        await processAvatarTask(
          task,
          context.policy,
          laneHealthy,
          context.cancelSignal
        )
      } else {
        await processTextTask(
          task,
          context.blacklistEntries,
          context.policy,
          laneHealthy,
          context.cancelSignal
        )
      }
    } catch (error) {
      // 按我们自己的信号判, 不看错误的样子: 中止之后抛出的是什么都不算这条任务的
      if (context.cancelSignal.aborted) {
        await releaseClaim(task.id)
        return
      }

      // 这一类模型没配 (例如刻意不配视觉模型): 不是故障, 不进熔断器, 直接转人工
      if (error instanceof ModerationConfigError) {
        await markTaskManual(task.id, {
          kind: 'misconfigured',
          reason: error.message
        })
        return
      }

      const failure = describeFailure(error)
      const record = breaker.recordFailure({
        ...failure,
        taskId: task.id,
        probe: holdsProbe
      })
      // 失败已回报给熔断器, 名额随之了结
      holdsProbe = false
      await applyAccounting(
        task.id,
        decideFailureAccounting({ task, ...failure, record, now: Date.now() })
      )
      console.error(`Moderation task ${task.id} attempt failed:`, error)
    }
  } finally {
    // 拿了探测名额却没有调到依赖 (没抢到认领、命中黑名单或缓存、转人工、被中止): 归还,
    // 否则车道会停在 half_open 直到名额的占用期满
    if (holdsProbe) {
      breaker.releaseProbe()
    }
  }
}

// resource/rating 裁决在 apply 后处理会读改写 patch 级聚合 (resource→recalcPatchType
// 改 patch.type; rating→recomputePatchRatingStat 改 patch_rating_stat), 由 patch 级通告锁
// 串行化; 序列化 key 把同 patch 的这两类归同组 (池里同一个键至多一条在途) 以降低锁争用与
// 并发面: 同一 patch 串行、不同 patch 并行 (resource 与 rating 写不同聚合本不互斥, 合用
// patch:<id> 键属保守简化); 旧任务无 patch_id 时降级按类型整体串行. avatar/bio 写同一
// user 行, 按 user 分组; 评论各自独立, 全并发。正确性不靠它 (supersede、status CAS、patch
// 通告锁与 user 行锁), 它只把争用维持在原来的水平
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

// blacklist 只被这一个 cron 进程读、且极少变动, 进程内短 TTL 缓存即可, 免去每一轮取任务
// 的全表重载 (与 getModerationConfig 同一权衡: 命中即拒的新规则最长延迟
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

// 每条车道一次取多少条候选: 槽位数的两倍, 跳过同键在途的之后通常还够填满空出的槽位
const CANDIDATE_WINDOW = MODERATION_CONCURRENCY * 2

// 按车道取候选: 一条车道被挡住时另一条照常取, 不被排在前面的对方任务占满。content_type 只是
// 过滤条件, 仍走 [status, next_attempt] 索引。返回按就绪时刻排好的候选, 已替 probe 车道排最前
// 的那一条登记探测名额; report 为真时先上报一次车道状态 (池的第一轮)
const fetchCandidates = async (
  worker: ModerationWorker,
  leaseStaleBefore: Date,
  { report }: { report: boolean }
) => {
  const admissions = {
    text: worker.breakers.text.admit(),
    avatar: worker.breakers.avatar.admit()
  }
  const releaseProbes = (keep: Set<ModerationLane> = new Set()) => {
    for (const lane of MODERATION_LANE) {
      if (admissions[lane] === 'probe' && !keep.has(lane)) {
        worker.breakers[lane].releaseProbe()
      }
    }
  }

  // 被挡住的车道不取, 探测只取一条
  const takeOf = (lane: ModerationLane) => {
    if (admissions[lane] === 'pass') {
      return CANDIDATE_WINDOW
    }
    return admissions[lane] === 'probe' ? 1 : 0
  }
  const now = new Date()
  const fetchLane = async (lane: ModerationLane) => {
    const take = takeOf(lane)
    if (take === 0) {
      return []
    }
    const where: Prisma.moderation_taskWhereInput = {
      ...claimablePredicate(now, leaseStaleBefore),
      content_type: lane === 'avatar' ? 'avatar' : { not: 'avatar' }
    }
    if (admissions[lane] === 'probe') {
      // 探测要回答的是「依赖现在好了吗」, 所以挑最不可能自己有毛病的那一条: 还没失败过
      // 的任务里最新到的。按就绪时刻取的话, 探测总落在把车道打开的那一波内容上 ——
      // 失败过的 5 秒后就到重试时刻, 同一波里还没轮到的入队也更早, 都排在后到的正常
      // 内容前面; 它们若是各有各的毛病 (只有它们被网关 403), 探测一次次失败、暂停逐次
      // 翻倍, 正常内容跟着等。队列里只剩失败过的任务时才按就绪时刻取它们 —— 故障
      // 结束后的积压要靠这一条动起来。没失败过的任务 next_attempt 就是入队时刻, 按它
      // 倒序即「最新到的」, 且仍走 [status, next_attempt] 索引
      const fresh = await prisma.moderation_task.findMany({
        where: { ...where, failure_kind: '' },
        orderBy: { next_attempt: 'desc' },
        take: 1
      })
      if (fresh.length) {
        return fresh
      }
    }
    return prisma.moderation_task.findMany({
      where,
      // 按 next_attempt 升序取: 与 [status, next_attempt] 索引同序, Postgres
      // 直接索引取前 N 免去额外 Sort. next_attempt 是范围条件, 其后的列 (如
      // created) 在索引里不构成有序, 故加复合索引也消不掉排序; 换排序键才是
      // 零成本解. 未重试任务 next_attempt 默认等于 created, FIFO 不变, 重试
      // 任务则按就绪时刻公平排队
      orderBy: { next_attempt: 'asc' },
      take
    })
  }
  let fetched: moderation_taskModel[][]
  try {
    if (report) {
      // 车道状态以问过门之后的为准 (到点的 open 此刻已是 half_open)
      await reportHealth(worker)
    }
    fetched = await Promise.all(MODERATION_LANE.map(fetchLane))
  } catch (error) {
    releaseProbes()
    throw error
  }

  const tasks = fetched
    .flat()
    .sort((a, b) => a.next_attempt.getTime() - b.next_attempt.getTime())

  // 探测名额交给该车道排最前的那一条; 没有可认领的任务就归还
  const probeTaskIds = new Set<number>()
  const probedLanes = new Set<ModerationLane>()
  for (const task of tasks) {
    const lane = laneOf(task)
    if (admissions[lane] === 'probe' && !probedLanes.has(lane)) {
      probedLanes.add(lane)
      probeTaskIds.add(task.id)
    }
  }
  releaseProbes(probedLanes)

  return { tasks, probeTaskIds }
}

// 池运行期间的心跳间隔: 池可以连续运行很久 (一次慢的模型调用就是数分钟), 期间车道状态的键
// 不能过期
const HEALTH_HEARTBEAT_MS = 30 * 1000

// 没有可开始的任务、又有任务在途时, 最长隔这么久再取一次 (与 cron 一拍同长): 新到的任务
// 不必等在途的慢调用结束
const POOL_POLL_MS = 15 * 1000

interface InFlightTask {
  key: string
  done: Promise<void>
}

// 等到一条在途任务结束、到了下一次查看的时刻、或 signal 中止, 先到者为准
const waitForSlot = async (
  inFlight: Map<number, InFlightTask>,
  signal: AbortSignal
) => {
  if (signal.aborted) {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let wake = () => {}
  try {
    await Promise.race([
      ...[...inFlight.values()].map(({ done }) => done),
      new Promise<void>((resolve) => {
        wake = () => resolve()
        timer = setTimeout(wake, POOL_POLL_MS)
        signal.addEventListener('abort', wake, { once: true })
      })
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', wake)
  }
}

export interface ModerationPoolContext {
  // 租约丢失或作业运行时开始关停时中止: 不再取新的任务, 在途的做完
  signal: AbortSignal
  // 关停的宽限期满时中止: 在途的模型与存储调用放弃, 认领清掉 (见 releaseClaim)
  cancelSignal: AbortSignal
}

// 连续工作池: 槽位 (MODERATION_CONCURRENCY) 空出来就取下一条, 不等同一轮的其余任务 —— 一次
// 慢的模型调用只占一个槽位, 不拖住整条队列。没有可开始的任务、也没有在途任务时返回, 作业层的
// 下一拍再来。同一个序列化键至多一条在途。
// 任何一条任务的写库失败 (认领、记账、转人工) 都让池停止取新任务、等在途的结束后返回: 库此刻
// 写不进去时, 每个立即空出的槽位都会马上再开一轮, 在库上空转; 停下来就回到每拍至多一轮。
// 导出只为测试: 生产里只由下面的作业在租约内调用
export const runModerationPool = async (
  worker: ModerationWorker,
  { signal, cancelSignal }: ModerationPoolContext
) => {
  const inFlight = new Map<number, InFlightTask>()
  let crashed = false
  let rounds = 0
  let startedAny = false
  const heartbeat = setInterval(
    () => void reportHealth(worker),
    HEALTH_HEARTBEAT_MS
  )
  try {
    // 宽限期满之前 signal 总是先中止; 也看 cancelSignal, 免得刚清掉认领的任务又被取回来
    while (!signal.aborted && !cancelSignal.aborted && !crashed) {
      const free = MODERATION_CONCURRENCY - inFlight.size
      if (free > 0) {
        // 早于此刻的租约视为过期 (worker 崩溃), 连同未认领的行一起纳入候选; 认领时按行
        // 二次校验租约, 避免与仍在处理该行的其它 worker 撞车
        const leaseStaleBefore = new Date(
          Date.now() - MODERATION_LEASE_SECONDS * 1000
        )
        const { tasks, probeTaskIds } = await fetchCandidates(
          worker,
          leaseStaleBefore,
          { report: rounds++ === 0 }
        )

        // 就绪早的先; 跳过在途的 (认领还没落库的那一刻仍取得到) 与同键在途的
        const busyKeys = new Set([...inFlight.values()].map(({ key }) => key))
        const picked: moderation_taskModel[] = []
        for (const task of tasks) {
          const key = serializationKey(task)
          if (
            picked.length < free &&
            !inFlight.has(task.id) &&
            !busyKeys.has(key)
          ) {
            busyKeys.add(key)
            picked.push(task)
          } else if (probeTaskIds.delete(task.id)) {
            // 探测的那条这一轮开始不了 (槽位已满、同键在途): 归还, 下一轮再探
            worker.breakers[laneOf(task)].releaseProbe()
          }
        }

        if (picked.length) {
          let shared: Omit<TaskContext, 'probe'>
          try {
            // blacklist 仅文本任务需要: 纯头像的一轮跳过查询, 其余走进程内缓存
            const needsBlacklist = picked.some(
              (task) => task.content_type !== 'avatar'
            )
            shared = {
              policy: loadModerationPolicy(),
              blacklistEntries: needsBlacklist
                ? await getBlacklistEntries()
                : [],
              leaseStaleBefore,
              cancelSignal
            }
          } catch (error) {
            for (const task of picked) {
              if (probeTaskIds.has(task.id)) {
                worker.breakers[laneOf(task)].releaseProbe()
              }
            }
            throw error
          }
          startedAny = true
          for (const task of picked) {
            const done = processTask(worker, task, {
              ...shared,
              probe: probeTaskIds.has(task.id)
            })
              .catch((error) => {
                crashed = true
                console.error('Moderation worker crashed:', error)
              })
              .finally(() => {
                inFlight.delete(task.id)
              })
            inFlight.set(task.id, { key: serializationKey(task), done })
          }
        } else if (inFlight.size === 0) {
          return
        }
      }
      await waitForSlot(inFlight, signal)
    }
  } finally {
    // 不管为什么结束 (队列空、要求停下、写库失败、取任务出错), 都等在途的做完再返回:
    // 返回之后租约就释放了
    await Promise.allSettled([...inFlight.values()].map(({ done }) => done))
    clearInterval(heartbeat)
    // 处理过的任务可能刚把车道打开或闭合: 不等下一次上报, 现在就让管理端看到
    if (startedAny) {
      await reportHealth(worker)
    }
  }
}

export const moderationJob = defineScheduledJob({
  name: 'moderation',
  schedule: '*/15 * * * * *',
  lease: { key: 'moderation:worker:lock' },
  run: (ctx) => runModerationPool(defaultWorker, ctx)
})
