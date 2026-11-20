export const MODERATION_CONTENT_TYPE = [
  'comment',
  'rating',
  'resource',
  'avatar',
  'bio'
] as const

export type ModerationContentType = (typeof MODERATION_CONTENT_TYPE)[number]

// 走文本审核 (可被黑名单命中) 的 content_type; avatar 为图片审核, 不适用黑名单
export const MODERATION_TEXT_CONTENT_TYPE = [
  'comment',
  'rating',
  'resource',
  'bio'
] as const

export type ModerationTextType = (typeof MODERATION_TEXT_CONTENT_TYPE)[number]

export const MODERATION_CONTENT_TYPE_MAP: Record<string, string> = {
  comment: '评论',
  rating: '评价',
  resource: '资源',
  avatar: '头像',
  bio: '签名'
}

// 黑名单生效类型的展示文案; 空数组 = 全部生效
export const formatModerationContentTypeLabel = (types: string[]) =>
  types.length
    ? types.map((type) => MODERATION_CONTENT_TYPE_MAP[type]).join('/')
    : '全部'

export const MODERATION_TASK_STATUS = [
  'pending',
  'approved',
  'rejected',
  'manual',
  'superseded'
] as const

export type ModerationTaskStatus = (typeof MODERATION_TASK_STATUS)[number]

export const MODERATION_TASK_STATUS_MAP: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
  manual: '转人工',
  superseded: '已失效'
}

export const MODERATION_REJECT_CODE_MAP: Record<string, string> = {
  POL: '现实政治敏感',
  AD: '广告引流',
  SEX: '违规色情内容',
  CSA: '涉未成年人色情',
  ATK: '辱骂与人身攻击',
  PII: '泄露他人隐私',
  ILL: '违法信息',
  FEE: '违反免费原则',
  COL: '系列合集类资源',
  VIO: '血腥暴力',
  EXT: '极端组织符号',
  BLK: '命中黑名单'
}

// system prompt (server/moderation/prompt.ts) 里的"不超过40字"与下面两个上限是同一
// 契约的两端: prompt 给模型目标, 这两个数只做落库兜底. 模型写长不该让一条正确的裁决
// 作废 (截断/丢弃策略见 server/moderation/ai.ts), 故留足余量. 单位是码点而非 UTF-16
// 单元, 故最坏 (全 emoji) 占 400 个单元, 仍远小于 reject_reason 列宽 VarChar(1007)
export const MODERATION_REASON_MAX_LENGTH = 200

// 类别码形态阈值: 上面 MODERATION_REJECT_CODE_MAP 的码是 2-3 字符, 16 容得下模型偶尔
// 输出的多重违规 (逗号连接四个三字母码 15 字符, 带空格分隔的三码 13 字符) —— 管理端
// 对表外的码回落原串展示, 保住多重码比丢弃更有信息量; 超此长度则是说明句而非类别码
export const MODERATION_CODE_MAX_LENGTH = 16

// 审核 prompt 与其规则片段见 server/moderation/prompt.ts: 本文件的 label 表被客户端
// 组件导入, 规则原文与之同模块会被打进 client chunk

// reject_reason (模型写出的具体命中点) 只落库供管理端排查, 不进用户可见文案: 逐条
// 复述命中点等同于把审核规则的边界透露给违规者, 便于其改写后重投. reject_code 经
// MODERATION_REJECT_CODE_MAP 映射出的类别名则在申诉页展示 —— 类别粒度不足以逆向出
// 规则边界, 但能告诉用户该往哪个方向改; 这里的通知文案仍不带, 保持消息体简短
// 类型注解不是装饰: 新增 MODERATION_CONTENT_TYPE 成员时这里缺键会在编译期报错,
// 挡住 apply.ts 拒绝分支按 content_type 取文案时的运行时 undefined
export const MODERATION_REJECT_NOTICE: Record<
  Exclude<ModerationContentType, 'resource'>,
  () => string
> & { resource: (name: string) => string } = {
  comment: () =>
    '您发布的评论未通过内容审核，已被隐藏。如有异议，您可以点击本条消息前往 账户设置 → 内容申诉，修改内容并提交人工复核。',
  rating: () =>
    '您发布的评价未通过内容审核，已被隐藏。如有异议，您可以点击本条消息前往 账户设置 → 内容申诉，修改内容并提交人工复核。',
  resource: (name: string) =>
    `您发布的资源「${name}」未通过内容审核，已被隐藏。如有异议，您可以点击本条消息前往 账户设置 → 内容申诉，修改内容并提交人工复核。`,
  avatar: () => '您提交的头像未通过内容审核，未被应用。如有异议请联系管理员。',
  bio: () => '您提交的签名未通过内容审核，未被应用。如有异议请联系管理员。'
}

// 这条内容自己的失败 (模型输出不合约定、落库被拒等) 最多试几次
export const MODERATION_MAX_RETRY = 3

// 依赖类失败 (供应商不可用、限流、凭据或地址不对) 最多推迟几次。它与上面那份预算分开:
// 依赖出问题时不该扣内容的预算, 但也不能无限推迟 —— 一条稳定打崩上游的内容 (只对它超时、
// 只有它被网关拦下) 单看每次失败都像依赖的问题, 这个上限就是它的止损。记账规则见
// server/moderation/accounting.ts
export const MODERATION_MAX_DEFERRALS = 6

// 任务最近一次失败的类别 (moderation_task.failure_kind), 管理端据此区分转人工的原因
export const MODERATION_FAILURE_KIND = [
  'unavailable',
  'rate_limited',
  'misconfigured',
  'bad_output',
  'internal',
  'crash_loop',
  'deferral_exhausted'
] as const

export type ModerationFailureKind = (typeof MODERATION_FAILURE_KIND)[number]

export const MODERATION_FAILURE_KIND_MAP: Record<
  ModerationFailureKind,
  string
> = {
  unavailable: '供应商不可用',
  rate_limited: '供应商限流',
  misconfigured: '配置错误',
  bad_output: '模型输出异常',
  internal: '内部错误',
  crash_loop: '处理反复中断',
  deferral_exhausted: '多次推迟仍失败'
}

// 表外的值 (将来新增的类别、旧数据) 回落原串展示
export const formatModerationFailureKind = (kind: string) =>
  (MODERATION_FAILURE_KIND_MAP as Record<string, string>)[kind] ?? kind

// 车道 = 一类任务共用的依赖: 文本任务共用文本模型, 头像任务共用视觉模型与对象存储。
// 一条车道的依赖出问题不拖住另一条
export const MODERATION_LANE = ['text', 'avatar'] as const

export type ModerationLane = (typeof MODERATION_LANE)[number]

export const MODERATION_LANE_MAP: Record<ModerationLane, string> = {
  text: '文本',
  avatar: '头像'
}

// 车道被暂停的原因 (BreakerReason), 管理端展示用
export const MODERATION_LANE_REASON_MAP: Record<string, string> = {
  dependency: '供应商不可用',
  rate_limited: '供应商限流',
  misconfigured: '配置错误',
  systematic: '系统性故障'
}

// 车道熔断的阈值 (server/moderation/breaker.ts)
export const MODERATION_BREAKER = {
  // 依赖类失败连续 3 次、且跨 2 条不同任务才算依赖的问题
  dependencyThreshold: 3,
  minDistinctTasks: 2,
  // 没有任何成功的前提下, 5 条不同任务都以输出异常 / 内部错误失败, 算系统性故障
  systematicThreshold: 5,
  // 打开 30 秒后放一条去探测, 探测失败逐次翻倍, 最长 5 分钟
  baseOpenMs: 30 * 1000,
  maxOpenMs: 5 * 60 * 1000
} as const

// 系统性故障检测 (上面的 systematicThreshold) 达到阈值时做什么。'log': 只记一行日志
// (pm2 logs | grep systematic_suspected), 不打开车道, 这类失败照旧逐条扣 retry。
// 'enforce': 打开车道。它分不清「模型整体坏了」与「连着来了几条模型答不好的内容」
// (供应商对违规内容拒答、提示注入), 后者在审核队列里并不少见, 而每误开一次整条车道
// 至少停 30 秒 —— 改成 'enforce' 之前先看生产日志里它多久出现一次、出现时是不是真的
// 整体故障
export const MODERATION_SYSTEMATIC_DETECTION = 'log' as 'log' | 'enforce'

export const MODERATION_BATCH_SIZE = 10

// 单批内并发处理的任务数上限, 即同时在途的 AI 调用数; 受 provider 限流约束,
// 应 <= MODERATION_BATCH_SIZE
export const MODERATION_CONCURRENCY = 5

// 单次调用的输出 token 上限. 推理模型的思考 (reasoning_content) 同样计入输出 token,
// 上限过小会让思考阶段耗尽预算、正文 content 为空, 任务白跑三次重试后转人工 —— 审核
// 正文本身只有几十 token, 这个上限存在的意义只是给思考留够空间, 不该成为约束. 取值
// 与 migration 目录下几支 AI 脚本一致 (同一 provider 实证可行). 真正的止损是
// MODERATION_AI_TIMEOUT_MS: 正常思考远不到这个量, 吃满上限只会发生在模型陷入循环时,
// 而那种情况会先撞上超时
export const MODERATION_AI_MAX_TOKENS = 10000

// worker 抢占锁 TTL: 单个 cron 进程独占一批审核的最长时间. 批次超此值时锁自然过期,
// 可能与下一 tick 并发 —— 由认领协议 (picked_at) 兜底正确性. 下面三个时间常量构成
// 不变式链, 集中于此以免跨文件漂移
export const MODERATION_LOCK_TTL_SECONDS = 600

// 认领租约时长: 处理前给任务行盖时间戳, 期内其它 worker 不重复处理该行; 超过此窗口
// 视为 worker 崩溃, 该行可被回收重跑. 须 > MODERATION_LOCK_TTL_SECONDS: 若二者相等,
// 锁刚过期时下一批次算出的 leaseStaleBefore 恰好越过在途行的 picked_at, 会把仍在处理
// 的行误判为崩溃并回收, 与原批次并发跑出一次重复 AI 调用. 代价是崩溃 worker 遗留的
// 任务最长隔这么久才被回收重跑, 审核延迟以此为上界
export const MODERATION_LEASE_SECONDS = 1200

// 单次 AI 调用超时: 必须 < MODERATION_LOCK_TTL_SECONDS, 把任务中 AI 调用的耗时经这一
// 网络调用上限约束在锁 TTL 内, 否则挂起的 provider 调用会拖到锁自然过期、触发另一批次
// 并发重跑. 慢推理模型约 15-20 token/s, 360s 可容纳 5000-7000 token 的思考 —— 审核一段
// 站内文本远用不到这个量, 合法慢响应不会被误杀; 真正吃满的是陷入循环的病态响应, 由此
// 超时止损 (超时属依赖类失败, 止损的次数上界是 MODERATION_MAX_DEFERRALS).
// 不变式链: AI 超时 (360s) < 锁 TTL (600s) < 认领租约 (1200s)
export const MODERATION_AI_TIMEOUT_MS = 360 * 1000

// avatar 任务在「认领→结算」窗口内除 AI 调用外还有阻塞式 S3 操作 (取 pending 图、copy
// 到正式 key), 若无超时, S3 卡死会让单任务处理耗时超过认领租约、被另一批次回收而重复
// 调用 AI. 给这些 S3 调用同样设超时, 使不变式链对头像也成立: 头像最坏处理耗时
// = get(60) + AI(360) + copy×2(120) = 540s < 认领租约 (1200s); 另有 sharp 解码与结算
// tx (各受自身 CPU / Prisma 默认超时约束), 660s 余量足以覆盖
export const MODERATION_S3_TIMEOUT_MS = 60 * 1000

export const MODERATION_VERDICT_CACHE_DURATION = 30 * 24 * 60 * 60
