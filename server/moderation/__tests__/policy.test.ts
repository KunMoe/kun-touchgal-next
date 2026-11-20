import { describe, expect, it } from 'vitest'
import { loadModerationPolicy } from '~/server/moderation/policy'

const env = (overrides: Record<string, string | undefined> = {}) =>
  ({
    MODERATION_AI_BASE_URL: 'https://ai.example/v1',
    MODERATION_AI_API_KEY: 'key',
    MODERATION_AI_TEXT_MODEL: 'text-a',
    MODERATION_AI_TEXT_REASONING_EFFORT: 'low',
    MODERATION_AI_VISION_MODEL: 'vision-a',
    MODERATION_AI_VISION_REASONING_EFFORT: '',
    ...overrides
  }) as unknown as NodeJS.ProcessEnv

describe('loadModerationPolicy', () => {
  it('读出 provider 与两类模型; 空串的思考强度当作没配', () => {
    expect(loadModerationPolicy(env())).toEqual({
      provider: { baseUrl: 'https://ai.example/v1', apiKey: 'key' },
      text: { model: 'text-a', reasoningEffort: 'low' },
      vision: { model: 'vision-a', reasoningEffort: undefined },
      textId: expect.stringMatching(/^[0-9a-f]{12}$/)
    })
  })

  it.each([
    ['地址', { MODERATION_AI_BASE_URL: '' }],
    ['密钥', { MODERATION_AI_API_KEY: undefined }]
  ])('%s没配: 没有 provider', (_name, overrides) => {
    expect(loadModerationPolicy(env(overrides)).provider).toBeNull()
  })

  it('某一类模型没配: 只有那一类为 null', () => {
    const policy = loadModerationPolicy(env({ MODERATION_AI_VISION_MODEL: '' }))

    expect(policy.vision).toBeNull()
    expect(policy.text).not.toBeNull()
  })
})

// textId 进裁决缓存键: 它变了, 旧裁决就不再命中
describe('文本裁决的策略身份', () => {
  const idOf = (overrides: Record<string, string | undefined> = {}) =>
    loadModerationPolicy(env(overrides)).textId

  it.each([
    ['文本模型', { MODERATION_AI_TEXT_MODEL: 'text-b' }],
    ['思考强度', { MODERATION_AI_TEXT_REASONING_EFFORT: 'high' }],
    ['去掉思考强度', { MODERATION_AI_TEXT_REASONING_EFFORT: '' }]
  ])('随%s改变', (_name, overrides) => {
    expect(idOf(overrides)).not.toBe(idOf())
  })

  it.each([
    ['provider 地址', { MODERATION_AI_BASE_URL: 'https://mirror.example/v1' }],
    ['密钥', { MODERATION_AI_API_KEY: 'another' }],
    ['视觉模型', { MODERATION_AI_VISION_MODEL: 'vision-b' }],
    ['视觉模型的思考强度', { MODERATION_AI_VISION_REASONING_EFFORT: 'high' }]
  ])(
    '不随%s改变: 白白失效一次缓存就是每段文本多调一次模型',
    (_name, overrides) => {
      expect(idOf(overrides)).toBe(idOf())
    }
  )

  it('模型名与思考强度各占一个维度, 不会因为取值串位而相同', () => {
    expect(
      idOf({
        MODERATION_AI_TEXT_MODEL: 'a',
        MODERATION_AI_TEXT_REASONING_EFFORT: 'b,c'
      })
    ).not.toBe(
      idOf({
        MODERATION_AI_TEXT_MODEL: 'a,b',
        MODERATION_AI_TEXT_REASONING_EFFORT: 'c'
      })
    )
  })
})
