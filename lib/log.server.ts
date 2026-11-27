// 服务端唯一的日志出口 (T38)。调用点只选事件: 级别、节流、允许写出的字段都由下面的登记表决定,
// 新事件先在 KUN_LOG_EVENTS 登记。每条一行 JSON:
//   {ts, level, event, app, pid, instance, release, fields, suppressed?, err?}
// warn / error 写 stderr, info 写 stdout (PM2 分别落到 error / out 日志)。
// - fields 只写登记过的字段, 其余键在运行时丢弃 (类型上的多余属性检查只对对象字面量生效, 拦不住
//   变量), 字符串截到 256 字符: 请求头、cookie、整行 user、中继的原始响应体进不了 fields;
//   以字符串形式写进字段的邮箱、令牌只能靠评审字段表把关
// - err 只留 name、message (截到 2000)、code、digest、前 15 帧调用栈与一层 cause (name、
//   message、code), 不留 Prisma 的 meta。调用栈只取 `at` 帧: 栈的首行就是 message 本身, 整段
//   留下等于绕过截断。message 本身不过滤: Prisma 的参数校验错误会把调用参数 (含 where 里的邮箱)
//   写进 message, 截断只降低、不消除这类泄漏
// - 节流在进程内: 键为「事件 × throttleBy 字段的值」, 一个窗口只放行第一条, 下一条放行时带上
//   这期间压下的条数 (suppressed)。throttleBy 只能指向低基数字段 (命名空间、状态), 不能是 id
// - kunLog 永不抛出: 写不出去、序列化失败都只影响这一行, 不影响调用方
// 不 import 'server-only': instrumentation 与 cron 进程不在 react-server 层, 那个包的默认入口
// 一加载就抛错。.server.ts 后缀由 __tests__/client-bundle-boundary.test.ts 拦住客户端引用

type KunLogLevel = 'info' | 'warn' | 'error'

export type KunLogValue = string | number | boolean | null

interface KunLogSpec {
  level: KunLogLevel
  fields: readonly string[]
  throttleMs?: number
  throttleBy?: string
}

const MINUTE = 60_000

export const KUN_LOG_EVENTS = {
  // —— 框架钩子与进程 (instrumentation.ts) ——
  // 没被任何人接住、冒到 Next 的请求错误 (页面渲染、Route Handler、Server Action、proxy)。
  // path 不带 query, requestId 只取 x-request-id, 其余请求头一概不读
  'request.unhandled': {
    level: 'error',
    fields: [
      'path',
      'method',
      'routePath',
      'routeType',
      'renderSource',
      'revalidateReason',
      'digest',
      'requestId'
    ]
  },
  'process.unhandled': { level: 'error', fields: ['kind'] },

  // —— 请求入口 ——
  // kunRoute 兜底翻译的三类 Prisma 违例 (外键、唯一、目标行不存在)
  'route.violation': {
    level: 'warn',
    fields: ['method', 'path', 'uid', 'code']
  },
  // kunReadBody 的拒绝: 据此发现误拒的入口、调大它的预算
  'body.rejected': {
    level: 'warn',
    fields: ['path', 'reason', 'maxBytes', 'declared', 'received']
  },

  // —— 依赖 ——
  'dep.redis': {
    level: 'warn',
    fields: ['state'],
    throttleMs: MINUTE,
    throttleBy: 'state'
  },
  // 不节流: 只在连上时出现, 压下的话最后一条可见的就是断线, 看上去像一直没恢复
  'dep.redis_ready': { level: 'info', fields: [] },
  'dep.pg_pool_error': { level: 'error', fields: [], throttleMs: MINUTE },

  // —— 读缓存 ——
  // 缓存读写失败, 调用方改为直连库或放弃写入。op 是失败的那一步
  'cache.degraded': {
    level: 'warn',
    fields: ['ns', 'op', 'key'],
    throttleMs: MINUTE,
    throttleBy: 'ns'
  },
  // 失效没做成: 旧条目要等 TTL 才会消失
  'cache.invalidate_failed': {
    level: 'warn',
    fields: ['ns', 'op', 'key'],
    throttleMs: MINUTE,
    throttleBy: 'ns'
  },

  // —— 认证与会话 ——
  // 2FA、二次验证依赖的 Redis / 库调用失败, 本次按不可用拒绝
  'auth.dependency_failed': {
    level: 'error',
    fields: ['stage'],
    throttleMs: MINUTE,
    throttleBy: 'stage'
  },
  'auth.session_unavailable': {
    level: 'error',
    fields: ['source'],
    throttleMs: MINUTE,
    throttleBy: 'source'
  },
  // 应当登出的会话没删掉
  'auth.session_revoke_failed': {
    level: 'error',
    fields: ['reason', 'uid']
  },
  // 令牌上的安全戳与库里的不符 (server/auth/securityStamp.ts)
  'auth.security_stamp_mismatch': {
    level: 'warn',
    fields: [
      'mode',
      'source',
      'uid',
      'jti',
      'kind',
      'issuedAt',
      'tokenStamp',
      'userStamp'
    ]
  },

  // —— 写入口的频率预算 (server/abuse) ——
  // 计数用的 Redis 出错, 按设计放行
  'abuse.budget_unavailable': {
    level: 'warn',
    fields: ['policies'],
    throttleMs: MINUTE
  },
  'abuse.mention_dropped': {
    level: 'warn',
    fields: ['commentId', 'senderUid', 'recipients', 'retryAfterSec']
  },

  // —— 内容 ——
  'render.failed': { level: 'error', fields: ['profile'] },
  'comment.html_persist_failed': { level: 'warn', fields: [] },
  'comment.notify_failed': { level: 'error', fields: ['commentId'] },
  'patch.views_failed': {
    level: 'warn',
    fields: ['op'],
    throttleMs: MINUTE,
    throttleBy: 'op'
  },
  'edit.external_data_failed': {
    level: 'error',
    fields: ['source', 'patchId']
  },
  'tx.settle_failed': { level: 'error', fields: ['tx', 'stage'] },
  'image.encode_failed': { level: 'warn', fields: [] },

  // —— 出站调用 ——
  'external.request_failed': {
    level: 'warn',
    fields: ['source', 'id', 'status']
  },
  'cdn.purge_failed': { level: 'warn', fields: ['via', 'status', 'files'] },
  // 中继的原始响应体不写: 里面可能带收件地址
  'email.send_failed': {
    level: 'error',
    fields: ['tag', 'status', 'relayStatus', 'relayCode']
  },

  // —— 后台与审核 ——
  'admin.batch_item_failed': {
    level: 'error',
    fields: ['kind', 'action', 'id']
  },
  'admin.log_write_failed': { level: 'error', fields: ['action'] },
  'moderation.attempt_failed': {
    level: 'error',
    fields: ['taskId', 'scope']
  },
  'moderation.pool_failed': { level: 'error', fields: ['stage'] },
  // 车道每次开合与疑似系统性故障 (server/moderation/breaker.ts 的 BreakerEvent)
  'moderation.breaker': {
    level: 'warn',
    fields: [
      'lane',
      'type',
      'from',
      'to',
      'reason',
      'since',
      'openUntil',
      'opens',
      'tasks',
      'lastError'
    ]
  },
  'moderation.health_publish_failed': {
    level: 'warn',
    fields: [],
    throttleMs: MINUTE
  },
  'moderation.avatar_archive_failed': { level: 'error', fields: [] },

  // —— 对象存储 ——
  's3.delete_failed': { level: 'warn', fields: ['via', 'key'] },
  's3.outbox_row_skipped': { level: 'warn', fields: ['key'] },
  's3.outbox_row_failed': { level: 'error', fields: ['key'] },
  's3.drain_failed': { level: 'error', fields: [] },
  // 即时删除与入删除写出箱都失败: 对象没有任何引用, 也没人会再删它
  's3.orphan_left': { level: 'error', fields: ['via', 'key'] },
  // 要删的对象存储链接行没有 s3_key (历史行已回填, 不该再有): 对象入不了删除写出箱, 留在桶里,
  // 靠 scripts/auditResourceS3Orphans.ts 找回
  's3.link_without_key': { level: 'error', fields: ['count'] },
  'banner.pointer_unrecognized': {
    level: 'warn',
    fields: ['patchId', 'pointer']
  },
  'banner.recycle_enqueue_failed': {
    level: 'error',
    fields: ['patchId', 'keys']
  },
  'upload.promoted_meta_mismatch': {
    level: 'error',
    fields: [
      'key',
      'contentType',
      'contentDisposition',
      'contentLength',
      'declared'
    ]
  },
  'upload.promoted_meta_check_failed': { level: 'error', fields: ['key'] },
  // 转正失败后没退回已扣的当日上传额度
  'upload.quota_refund_failed': { level: 'error', fields: ['uid', 'mb'] },
  // 资源发布的每用户提交锁取不到 / 放不掉 (放不掉时这个用户 300 秒内提交不了)
  'lock.failed': { level: 'error', fields: ['lock', 'op'] },

  // —— 搜索 (Meilisearch 的错误只记摘要: name / status / code / message / cause) ——
  'search.request_rejected': {
    level: 'info',
    fields: ['name', 'status', 'code', 'message', 'cause']
  },
  // 索引与代码不一致 (pnpm search:ensure --check、密钥与地址), 本次改用 basic 引擎
  'search.engine_misconfigured': {
    level: 'error',
    fields: ['name', 'status', 'code', 'message', 'cause'],
    throttleMs: MINUTE
  },
  'search.engine_unavailable': {
    level: 'warn',
    fields: ['name', 'status', 'code', 'message', 'cause'],
    throttleMs: MINUTE
  },
  'search.count_query_failed': {
    level: 'warn',
    fields: ['name', 'status', 'code', 'message', 'cause'],
    throttleMs: MINUTE
  },
  'search.hits_dropped': {
    level: 'warn',
    fields: ['requested', 'dropped', 'ids']
  },
  'search.total_hits_exceeded': {
    level: 'error',
    fields: ['patchCount', 'maxTotalHits']
  },
  'search.total_hits_near_limit': {
    level: 'warn',
    fields: ['patchCount', 'maxTotalHits']
  },
  // cron 进程启动时的只读比对: 有扩张 / 变更 / 缺索引记 error, 只有收缩 (等 post 阶段下发) 记 warn
  'search.index_drift': { level: 'error', fields: ['missing', 'diffs'] },
  'search.index_drift_contract': { level: 'warn', fields: ['diffs'] },
  'search.index_check_failed': { level: 'error', fields: [] },
  'search.enqueue_failed': { level: 'error', fields: ['patchId'] },
  'search.drain_failed': { level: 'error', fields: [] },
  // 引擎整体收不了写入: 这一行挪后, 本轮停, 不计失败次数
  'search.outbox_deferred': { level: 'warn', fields: ['patchId'] },
  'search.outbox_row_failed': {
    level: 'error',
    fields: ['patchId', 'attempts', 'accounting']
  },
  'search.reconcile_doc_failed': { level: 'error', fields: ['patchId'] },
  'search.reconcile_finished': {
    level: 'info',
    fields: ['total', 'missing', 'extra', 'stale']
  },
  'search.counts_refresh_skipped': { level: 'warn', fields: ['waitSec'] },

  // —— 定时作业 (server/jobs) ——
  // 每个作业每 10 分钟一条, suppressed 是这期间又完成了几次: 当心跳看
  'job.finished': {
    level: 'info',
    fields: ['job', 'ms'],
    throttleMs: 10 * MINUTE,
    throttleBy: 'job'
  },
  'job.failed': { level: 'error', fields: ['job', 'ms'] },
  'job.tick_missed': { level: 'warn', fields: ['job', 'at'] },
  'job.lease_acquire_failed': { level: 'error', fields: ['job'] },
  'job.lease_lost': { level: 'error', fields: ['job', 'reason'] },
  'job.lease_release_failed': { level: 'warn', fields: ['job'] },
  'job.shutdown_signal': { level: 'info', fields: ['signal'] },
  'job.shutdown_waiting': { level: 'info', fields: ['jobs'] },
  'job.shutdown_grace_expired': { level: 'warn', fields: ['jobs'] },
  'job.shutdown_failed': { level: 'error', fields: [] },
  // 群发每拍一行 (空闲的拍不记): 发到哪了、为什么停
  'mail.campaign_step': {
    level: 'info',
    fields: ['kind', 'campaignId', 'sent', 'failed', 'reason']
  }
} as const satisfies Record<string, KunLogSpec>

export type KunLogEvent = keyof typeof KUN_LOG_EVENTS

type KunLogFieldName<E extends KunLogEvent> =
  (typeof KUN_LOG_EVENTS)[E]['fields'][number]

// undefined 的值不写出, 调用点可以直接传可选值。没有字段的事件只收空对象
export type KunLogFields<E extends KunLogEvent> = [KunLogFieldName<E>] extends [
  never
]
  ? Record<string, never>
  : Partial<Record<KunLogFieldName<E>, KunLogValue | undefined>>

const FIELD_MAX_LENGTH = 256
const ERROR_MESSAGE_MAX_LENGTH = 2000
const STACK_MAX_FRAMES = 15
const STACK_FRAME_MAX_LENGTH = 512

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text

const readField = (value: unknown): KunLogValue => {
  if (typeof value === 'string') {
    return truncate(value, FIELD_MAX_LENGTH)
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (value === null) {
    return null
  }
  // 类型拦不住的 (经 as 或 any 进来的对象): 只留字符串形式
  return truncate(String(value), FIELD_MAX_LENGTH)
}

interface KunLogErrorRecord {
  name?: string
  message: string
  code?: string | number
  digest?: string
  stack?: string[]
  cause?: KunLogErrorRecord
}

const serializeError = (value: unknown, nested: boolean): KunLogErrorRecord => {
  if (typeof value !== 'object' || value === null) {
    return { message: truncate(String(value), ERROR_MESSAGE_MAX_LENGTH) }
  }
  const source = value as Record<string, unknown>
  const record: KunLogErrorRecord = {
    message:
      typeof source.message === 'string'
        ? truncate(source.message, ERROR_MESSAGE_MAX_LENGTH)
        : truncate(String(value), ERROR_MESSAGE_MAX_LENGTH)
  }
  if (typeof source.name === 'string') {
    record.name = truncate(source.name, FIELD_MAX_LENGTH)
  }
  if (typeof source.code === 'string') {
    record.code = truncate(source.code, FIELD_MAX_LENGTH)
  } else if (typeof source.code === 'number') {
    record.code = source.code
  }
  if (nested) {
    return record
  }
  if (typeof source.digest === 'string') {
    record.digest = truncate(source.digest, FIELD_MAX_LENGTH)
  }
  if (typeof source.stack === 'string') {
    const frames = source.stack
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .slice(0, STACK_MAX_FRAMES)
      .map((line) => truncate(line.trim(), STACK_FRAME_MAX_LENGTH))
    if (frames.length) {
      record.stack = frames
    }
  }
  if (source.cause !== undefined) {
    record.cause = serializeError(source.cause, true)
  }
  return record
}

const appName = () => {
  if (!process.env.NEXT_RUNTIME) {
    return 'cli'
  }
  return process.env.KUN_ENABLE_CRON === 'true' ? 'cron' : 'web'
}

const throttleWindows = new Map<string, { until: number; suppressed: number }>()

// 返回 null 表示这一条被压下; 否则返回上一个窗口压下的条数
const passThrottle = (
  event: string,
  spec: KunLogSpec,
  fields: Record<string, unknown> | undefined
) => {
  if (!spec.throttleMs) {
    return 0
  }
  const key = spec.throttleBy
    ? `${event}\u0000${String(fields?.[spec.throttleBy])}`
    : event
  const now = Date.now()
  const window = throttleWindows.get(key)
  if (window && now < window.until) {
    window.suppressed += 1
    return null
  }
  throttleWindows.set(key, { until: now + spec.throttleMs, suppressed: 0 })
  return window?.suppressed ?? 0
}

const writeLine = (level: KunLogLevel, line: string) => {
  try {
    const stream = level === 'info' ? process.stdout : process.stderr
    stream.write(`${line}\n`)
  } catch {
    // 管道断了也不能让调用方失败
  }
}

export const kunLog = <E extends KunLogEvent>(
  event: E,
  fields?: KunLogFields<E>,
  err?: unknown
): void => {
  const ts = new Date().toISOString()
  let level: KunLogLevel = 'error'
  try {
    const spec: KunLogSpec = KUN_LOG_EVENTS[event]
    level = spec.level
    const raw = fields as Record<string, unknown> | undefined
    const suppressed = passThrottle(event, spec, raw)
    if (suppressed === null) {
      return
    }
    const written: Record<string, KunLogValue> = {}
    for (const name of spec.fields) {
      const value = raw?.[name]
      if (value !== undefined) {
        written[name] = readField(value)
      }
    }
    writeLine(
      level,
      JSON.stringify({
        ts,
        level,
        event,
        app: appName(),
        pid: process.pid,
        instance: process.env.NODE_APP_INSTANCE ?? null,
        release: process.env.KUN_RELEASE_SHA ?? null,
        fields: written,
        ...(suppressed > 0 ? { suppressed } : {}),
        ...(err === undefined ? {} : { err: serializeError(err, false) })
      })
    )
  } catch {
    // 读字段或错误对象时抛错 (getter、Proxy): 退化为只有事件与级别的一行
    writeLine(
      level,
      JSON.stringify({ ts, level, event, serializeFailed: true })
    )
  }
}
