import * as z from 'zod'
import {
  MODERATION_AI_MAX_TOKENS,
  MODERATION_AI_TIMEOUT_MS,
  MODERATION_CODE_MAX_LENGTH,
  MODERATION_REASON_MAX_LENGTH
} from '~/constants/moderation'
import type { ModerationContentType } from '~/constants/moderation'
import {
  DependencyFailure,
  classifyHttpStatus,
  parseRetryAfterMs,
  toDependencyFailure
} from '~/lib/resilience/failure'
import type { FailureScope } from '~/lib/resilience/failure'
import {
  MODERATION_AVATAR_SYSTEM_PROMPT,
  MODERATION_TEXT_SYSTEM_PROMPT
} from './prompt'
import type { ModerationModelPolicy, ModerationPolicy } from './policy'

// 这一类模型没配 (MODERATION_AI_TEXT_MODEL / MODERATION_AI_VISION_MODEL): 该类任务
// 直接转人工, 不重试。它不是故障 —— 不配视觉模型是一种有意的部署方式, 头像由人工审
export class ModerationConfigError extends Error {}

// 这里是 provider 边界: 调用模型的每一种失败都在这里说清它的范围 (见
// lib/resilience/failure.ts), worker 不再从错误的样子去猜。依赖答复了但输出不合约定
// (正文为空、不是 JSON、形状不符) 归 request —— 那是这一次调用自己的结果
const providerFailure = (
  scope: FailureScope,
  message: string,
  detail: { status?: number; retryAfterMs?: number | null } = {}
) =>
  new DependencyFailure({
    dependency: 'moderation_ai',
    scope,
    message,
    ...detail
  })

// prompt 要求输出 boolean, 但同时容忍 0/1: 模型偶尔的形态波动不该让整条内容
// 走完三次重试再转人工
const verdictFlag = z
  .union([z.boolean(), z.literal(0), z.literal(1)])
  .transform((value) => value === true || value === 1)

// code/reason 只是落库供管理端排查的附注 (不进用户可见文案, 见 MODERATION_REJECT_NOTICE),
// 裁决依据是 pass. 因这两个字段的长度报错的代价完全不对称: temperature=0 下重投产出几乎
// 相同, 三次重试注定同样失败, 只是白烧 token (avatar 还叠三次 S3 取图与 JPEG 编码), 最后
// 把一条 pass 判定正确的裁决打成转人工、内容持续隐藏. 故 reason 截断保留信息, code 超限
// 则丢弃 —— 那说明模型没按类别码输出, 该字段不可信, 由 resolveRejectReason 回落兜底
export const moderationVerdictSchema = z.object({
  pass: verdictFlag,
  code: z
    .string()
    .transform((value) =>
      value.length > MODERATION_CODE_MAX_LENGTH ? undefined : value
    )
    .optional(),
  // 按码点切而非 String.slice: 后者按 UTF-16 单元切, 边界落在代理对中间会留下孤立
  // 代理, 而 verdict 整体要写进 jsonb 列, JSON.stringify 会把它输出成字面 "\ud83d",
  // Postgres 拒收 (Unicode low surrogate must follow a high surrogate) —— 事务失败后
  // 同样是三次重试转人工, 恰好绕回这段代码要消除的结果
  reason: z
    .string()
    .transform((value) =>
      [...value].slice(0, MODERATION_REASON_MAX_LENGTH).join('')
    )
    .optional(),
  manual: verdictFlag.optional()
})

export type ModerationVerdict = z.infer<typeof moderationVerdictSchema>

export interface ModerationAiResult {
  verdict: ModerationVerdict
  model: string
  tokensIn: number
  tokensOut: number
}

export const parseModerationVerdict = (raw: string): ModerationVerdict => {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw providerFailure(
      'request',
      `Moderation verdict is not valid JSON: ${raw.slice(0, 200)}`
    )
  }

  const verdict = moderationVerdictSchema.safeParse(parsed)
  if (!verdict.success) {
    throw providerFailure(
      'request',
      `Invalid moderation verdict shape: ${raw.slice(0, 200)}`
    )
  }
  return verdict.data
}

type ChatMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >

const requestChatCompletion = async (
  provider: ModerationPolicy['provider'],
  { model, reasoningEffort }: ModerationModelPolicy,
  messages: Array<{ role: 'system' | 'user'; content: ChatMessageContent }>
): Promise<ModerationAiResult> => {
  // 地址或密钥没配: 与 provider 回 401 一样, 对所有任务同时成立, 不改配置不会好
  if (!provider) {
    throw providerFailure(
      'misconfigured',
      'MODERATION_AI_BASE_URL or MODERATION_AI_API_KEY is not configured'
    )
  }
  const { baseUrl, apiKey } = provider

  // try/catch 只包网络调用 (这里与下面的读流循环): 传输层的失败是依赖的, 其余代码
  // 抛的错不该被算到依赖头上
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    // 单次调用超时: 约束任务处理耗时在锁 TTL 内 (见 MODERATION_AI_TIMEOUT_MS); 超时会
    // abort 请求与响应体读取, 抛错后由 worker 走退避重试, 而非无限占用 worker
    signal: AbortSignal.timeout(MODERATION_AI_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      // 走 SSE 流式: Cloudflare 免费版 ~100s 无数据即 504, 非流式下慢推理模型必超;
      // 流式响应持续推 delta (网关注入的心跳同理), 只要流不断就不会触发该超时
      stream: true,
      // 见 MODERATION_AI_MAX_TOKENS: 这是上限而非实际消耗, 非推理模型仍只输出几个 token
      max_tokens: MODERATION_AI_MAX_TOKENS,
      // 思考强度: 仅在配置时透传 OpenAI 兼容的 reasoning_effort, 合法取值由
      // provider 决定故不做枚举校验; 未配置则不带该字段, 交给 provider 默认
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
    })
  }).catch((error) => {
    throw toDependencyFailure('moderation_ai', error)
  })
  if (!res.ok) {
    throw providerFailure(
      classifyHttpStatus(res.status),
      `Moderation AI request failed with status ${res.status}`,
      {
        status: res.status,
        retryAfterMs: parseRetryAfterMs(
          res.headers.get('retry-after'),
          Date.now()
        )
      }
    )
  }
  if (!res.body) {
    throw providerFailure(
      'transient',
      'Moderation AI response has no body stream'
    )
  }

  // 累积 OpenAI 兼容的流式增量, 等价于非流式的 choices[0].message.content 拼接;
  // 部分 chunk 可能只有 role delta 或空 choices; 非 data 行 (心跳注释、event 字段、
  // 空行) 与无法 JSON.parse 的 data 行 (纯文本 keep-alive) 均跳过
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let finishReason: string | null = null
  // 200 的流里夹带的错误对象 (上游引擎崩溃、网关转发的中途错误): provider 自己说失败了
  let streamError: { message: string; status: number | null } | null = null
  let modelName = model
  let tokensIn = 0
  let tokensOut = 0
  let done = false

  const handleDataLine = (line: string) => {
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') {
      done = true
      return
    }
    let chunk: unknown
    try {
      chunk = JSON.parse(payload)
    } catch {
      // 纯文本 keep-alive、或被心跳截断的前缀 (续段会以新 data 行续传,
      // 截断只丢前缀不构成审核结论损失时由正文为空检查兜底)
      return
    }
    if (!chunk || typeof chunk !== 'object') {
      return
    }
    const c = chunk as {
      error?: unknown
      model?: unknown
      choices?: Array<{
        delta?: { content?: unknown }
        finish_reason?: unknown
      }>
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
    }
    if (c.error !== undefined && c.error !== null) {
      const detail = (
        typeof c.error === 'object' ? c.error : { message: c.error }
      ) as { message?: unknown; code?: unknown }
      const code = Number(detail.code)
      streamError = {
        message:
          typeof detail.message === 'string'
            ? detail.message
            : JSON.stringify(c.error),
        // 有的网关把上游的 HTTP 状态码放在 error.code 里
        status:
          Number.isInteger(code) && code >= 400 && code <= 599 ? code : null
      }
    }
    if (typeof c.model === 'string') {
      modelName = c.model
    }
    const choice = c.choices?.[0]
    if (typeof choice?.delta?.content === 'string') {
      content += choice.delta.content
    }
    if (typeof choice?.finish_reason === 'string') {
      finishReason = choice.finish_reason
    }
    tokensIn = Number(c.usage?.prompt_tokens) || tokensIn
    tokensOut = Number(c.usage?.completion_tokens) || tokensOut
  }

  // 用 reader 而非 for-await: 项目 TS lib 未给 ReadableStream 暴露 asyncIterator
  const reader = res.body.getReader()
  while (true) {
    const { done: readerDone, value } = await reader.read().catch((error) => {
      throw toDependencyFailure('moderation_ai', error)
    })
    if (readerDone) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    // 只解析 data 行; 心跳注释/字段行/空行都跳过. 网络截断的 data 行会
    // 留在 buffer 直到 '\n' 到达续传, 天然完成重组
    for (const line of lines) {
      if (line.startsWith('data:')) {
        handleDataLine(line)
      }
    }
  }
  buffer += decoder.decode()
  if (buffer.startsWith('data:')) {
    handleDataLine(buffer)
  }

  // 不认错误对象的话, 这种流最后是「正文为空」, 会被算成这条内容自己的失败: 上游一出
  // 问题, 每条任务都白扣三次重试。带状态码的按状态码分类, 其余当作此刻不可用
  if (streamError) {
    const { message, status } = streamError as {
      message: string
      status: number | null
    }
    throw providerFailure(
      status === null ? 'transient' : classifyHttpStatus(status),
      `Moderation AI stream reported an error: ${message.slice(0, 200)}`,
      { status: status ?? undefined }
    )
  }
  // 流在 [DONE] 之前就结束: 连接被掐断或网关超时, 不是这条内容的问题
  if (!done) {
    throw providerFailure(
      'transient',
      'Moderation AI stream ended without [DONE]'
    )
  }
  if (!content.trim()) {
    throw providerFailure(
      'request',
      `AI 返回正文为空 (finish_reason: ${finishReason ?? 'unknown'}), ` +
        `若为 length 通常是推理模型的思考耗尽了 max_tokens (${MODERATION_AI_MAX_TOKENS})`
    )
  }

  return {
    verdict: parseModerationVerdict(content),
    model: modelName,
    tokensIn,
    tokensOut
  }
}

// userMessage 由 buildModerationUserMessage 生成 (server/moderation/prompt.ts),
// 这里原样作为用户消息发出, 不再做任何包裹或拼接
export const moderateText = async (
  policy: ModerationPolicy,
  contentType: Exclude<ModerationContentType, 'avatar'>,
  userMessage: string
) => {
  if (!policy.text) {
    throw new ModerationConfigError(
      'MODERATION_AI_TEXT_MODEL is not configured'
    )
  }
  return requestChatCompletion(policy.provider, policy.text, [
    { role: 'system', content: MODERATION_TEXT_SYSTEM_PROMPT[contentType] },
    { role: 'user', content: userMessage }
  ])
}

// 头像任务在取图之前先问这一句: 没配视觉模型的任务注定转人工, 不该先去碰存储
export const requireVisionModel = (policy: ModerationPolicy) => {
  if (!policy.vision) {
    throw new ModerationConfigError(
      'MODERATION_AI_VISION_MODEL is not configured'
    )
  }
  return policy.vision
}

export const moderateImage = async (
  policy: ModerationPolicy,
  jpegBase64: string
) =>
  requestChatCompletion(policy.provider, requireVisionModel(policy), [
    { role: 'system', content: MODERATION_AVATAR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请审核这张用户头像' },
        {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${jpegBase64}` }
        }
      ]
    }
  ])
