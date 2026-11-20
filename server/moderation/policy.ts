import { createHash } from 'crypto'
import { MODERATION_PROMPT_VERSION } from './prompt'

// 审核策略: 一次裁决由哪个 provider、哪个模型、多大的思考强度、哪一版 prompt 给出。
// worker 每批读一次环境变量得到它, 这一批里的每次调用与每个缓存键用的是同一份 ——
// ai.ts 不在调用点现读环境变量

export interface ModerationModelPolicy {
  model: string
  // 未配置则请求里不带 reasoning_effort, 交给 provider 默认
  reasoningEffort: string | undefined
}

export interface ModerationPolicy {
  // 地址或密钥没配时为 null: 所有调用都发不出去, 对整条车道成立 (见 ai.ts)
  provider: { baseUrl: string; apiKey: string } | null
  // 这一类模型没配时为 null: 该类任务直接转人工 (例如刻意不配视觉模型)
  text: ModerationModelPolicy | null
  vision: ModerationModelPolicy | null
  // 文本裁决的策略身份: 决定「同一段文本会不会得到同一个裁决」的全部维度, 进裁决
  // 缓存键。换模型、调思考强度、改 prompt 任何一样, 旧裁决即失效 —— 此前键里只有
  // prompt 版本, 换模型后最长 30 天内仍在回放旧模型的裁决。
  // 不进身份的: provider 的地址与密钥 (同一个模型换个入口不改变裁决)、max_tokens
  // (只决定调用成不成, 不改变裁决)、送审文本的截断 (发生在取 hash 之前, 已在文本的
  // hash 里); 视觉模型没有裁决缓存
  textId: string
}

const modelPolicyOf = (
  model: string | undefined,
  reasoningEffort: string | undefined
): ModerationModelPolicy | null =>
  model ? { model, reasoningEffort: reasoningEffort || undefined } : null

export const loadModerationPolicy = (
  env: NodeJS.ProcessEnv = process.env
): ModerationPolicy => {
  const baseUrl = env.MODERATION_AI_BASE_URL
  const apiKey = env.MODERATION_AI_API_KEY
  const text = modelPolicyOf(
    env.MODERATION_AI_TEXT_MODEL,
    env.MODERATION_AI_TEXT_REASONING_EFFORT
  )

  return {
    provider: baseUrl && apiKey ? { baseUrl, apiKey } : null,
    text,
    vision: modelPolicyOf(
      env.MODERATION_AI_VISION_MODEL,
      env.MODERATION_AI_VISION_REASONING_EFFORT
    ),
    // 数组经 JSON 序列化: 各维度之间不会因为取值里恰好有分隔符而串位
    textId: createHash('sha256')
      .update(
        JSON.stringify([
          MODERATION_PROMPT_VERSION,
          text?.model ?? '',
          text?.reasoningEffort ?? ''
        ])
      )
      .digest('hex')
      .slice(0, 12)
  }
}
