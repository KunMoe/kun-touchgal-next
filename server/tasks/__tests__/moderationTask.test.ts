import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { moderation_taskModel } from '~/prisma/generated/prisma/models'
import { KUN_MODERATION_VERDICT_CACHE_KEY } from '~/config/redis'
import { MODERATION_VERDICT_CACHE_DURATION } from '~/constants/moderation'
import { MODERATION_PROMPT_VERSION } from '~/server/moderation/prompt'

const {
  getKvMock,
  setKvMock,
  moderateTextMock,
  applyModerationVerdictMock,
  markTaskManualMock
} = vi.hoisted(() => ({
  getKvMock: vi.fn(),
  setKvMock: vi.fn(),
  moderateTextMock: vi.fn(),
  applyModerationVerdictMock: vi.fn(),
  markTaskManualMock: vi.fn()
}))

vi.mock('node-cron', () => ({ default: { createTask: vi.fn() } }))
vi.mock('sharp', () => ({ default: vi.fn() }))
vi.mock('~/prisma', () => ({ prisma: {} }))
vi.mock('~/lib/redis', () => ({ getKv: getKvMock, setKv: setKvMock }))
vi.mock('~/lib/s3', () => ({ getFileFromS3: vi.fn() }))
vi.mock('~/server/image/encodeLimit', () => ({ withEncodeSlot: vi.fn() }))
vi.mock('~/server/tasks/withTaskLock', () => ({ withTaskLock: vi.fn() }))
vi.mock('~/server/moderation/apply', () => ({
  applyModerationVerdict: applyModerationVerdictMock,
  markTaskManual: markTaskManualMock
}))
vi.mock(import('~/server/moderation/ai'), async (importOriginal) => ({
  ...(await importOriginal()),
  moderateText: moderateTextMock,
  moderateImage: vi.fn()
}))

import {
  processAvatarTask,
  processTextTask
} from '~/server/tasks/moderationTask'

const makeTask = (
  contentType: string,
  payload: Record<string, unknown>
): moderation_taskModel =>
  ({
    id: 1,
    content_type: contentType,
    content_id: 10,
    patch_id: null,
    user_id: 7,
    payload,
    retry: 0,
    picked_at: null,
    dry_run: false
  }) as unknown as moderation_taskModel

// 归一化: NFKC → 小写 → 去空白 (server/moderation/prefilter.ts)
const cacheKeyOf = (contentType: string, normalizedText: string) =>
  `${KUN_MODERATION_VERDICT_CACHE_KEY}:v${MODERATION_PROMPT_VERSION}:${contentType}:${createHash('sha256').update(normalizedText).digest('hex')}`

const aiResult = (verdict: Record<string, unknown>) => ({
  verdict,
  model: 'test-model',
  tokensIn: 120,
  tokensOut: 8
})

beforeEach(() => {
  vi.resetAllMocks()
  getKvMock.mockResolvedValue(null)
  setKvMock.mockResolvedValue(undefined)
  moderateTextMock.mockResolvedValue(aiResult({ pass: true }))
  applyModerationVerdictMock.mockResolvedValue(undefined)
})

describe('processTextTask: 黑名单', () => {
  it('命中即拒, 不查缓存也不调模型', async () => {
    const task = makeTask('comment', { text: '快来加 ABC 群' })

    await processTextTask(task, [{ pattern: 'abc群', content_types: [] }])

    expect(applyModerationVerdictMock).toHaveBeenCalledTimes(1)
    expect(applyModerationVerdictMock).toHaveBeenCalledWith({
      task,
      approved: false,
      rejectCode: 'BLK',
      rejectReason: '命中黑名单',
      model: 'blacklist'
    })
    expect(getKvMock).not.toHaveBeenCalled()
    expect(moderateTextMock).not.toHaveBeenCalled()
  })

  it('只对 content_types 包含该类型的条目生效', async () => {
    const task = makeTask('comment', { text: '快来加 ABC 群' })

    await processTextTask(task, [
      { pattern: 'abc群', content_types: ['rating', 'bio'] }
    ])

    expect(moderateTextMock).toHaveBeenCalledTimes(1)
    expect(applyModerationVerdictMock).toHaveBeenCalledWith(
      expect.objectContaining({ approved: true, model: 'test-model' })
    )
  })
})

describe('processTextTask: 裁决缓存', () => {
  it('命中时直接套用缓存裁决, 不调模型, 键含 prompt 版本与 content_type', async () => {
    getKvMock.mockResolvedValue(
      JSON.stringify({ pass: false, code: 'AD', reason: '引流' })
    )
    const task = makeTask('rating', { text: 'Hello  World' })

    await processTextTask(task, [])

    expect(getKvMock).toHaveBeenCalledWith(cacheKeyOf('rating', 'helloworld'))
    expect(moderateTextMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
    expect(applyModerationVerdictMock).toHaveBeenCalledWith({
      task,
      approved: false,
      manual: false,
      rejectCode: 'AD',
      rejectReason: '引流',
      verdict: { pass: false, code: 'AD', reason: '引流' },
      model: 'cache',
      tokensIn: 0,
      tokensOut: 0
    })
  })

  it('缓存内容不是合法裁决时回落到模型', async () => {
    getKvMock.mockResolvedValue('not-json')

    await processTextTask(makeTask('comment', { text: 'hello' }), [])

    expect(moderateTextMock).toHaveBeenCalledTimes(1)
  })

  // 黑名单要剥不可见字符才抓得住拆词, 缓存键则不能剥: 否则带双向控制符 (显示顺序
  // 被翻转) 的文本会直接命中乱序版本的旧裁决
  it('缓存键保留不可见字符, 黑名单匹配照样剥掉它们', async () => {
    await processTextTask(makeTask('comment', { text: '\u202E信微加' }), [])
    await processTextTask(makeTask('comment', { text: '信微加' }), [])

    expect(getKvMock.mock.calls[0][0]).not.toBe(getKvMock.mock.calls[1][0])

    vi.clearAllMocks()
    const task = makeTask('comment', { text: '加\u200B微信' })
    await processTextTask(task, [{ pattern: '加微信', content_types: [] }])

    expect(applyModerationVerdictMock).toHaveBeenCalledWith(
      expect.objectContaining({ rejectCode: 'BLK' })
    )
  })
})

describe('processTextTask: 调用模型', () => {
  it('把 payload.text 原样交给模型, 缓存裁决后落库', async () => {
    const verdict = { pass: true, manual: true }
    moderateTextMock.mockResolvedValue(aiResult(verdict))
    const task = makeTask('comment', { text: '一段 需要 审核 的评论' })

    await processTextTask(task, [])

    expect(moderateTextMock).toHaveBeenCalledWith(
      'comment',
      '一段 需要 审核 的评论'
    )
    expect(setKvMock).toHaveBeenCalledWith(
      cacheKeyOf('comment', '一段需要审核的评论'),
      JSON.stringify(verdict),
      MODERATION_VERDICT_CACHE_DURATION
    )
    expect(applyModerationVerdictMock).toHaveBeenCalledWith({
      task,
      approved: true,
      manual: true,
      rejectCode: undefined,
      rejectReason: undefined,
      verdict,
      model: 'test-model',
      tokensIn: 120,
      tokensOut: 8
    })
  })

  it('模型调用抛错时不落裁决, 由上层按重试/转人工记账', async () => {
    moderateTextMock.mockRejectedValue(new Error('upstream 502'))

    await expect(
      processTextTask(makeTask('comment', { text: 'hello' }), [])
    ).rejects.toThrow('upstream 502')

    expect(applyModerationVerdictMock).not.toHaveBeenCalled()
    expect(setKvMock).not.toHaveBeenCalled()
  })
})

describe('processTextTask: v1 载荷', () => {
  it('资源任务的 text 是「标题/介绍」平铺文本, name 不参与审核', async () => {
    const task = makeTask('resource', {
      text: '标题: Patch v1 介绍: 汉化补丁',
      name: 'Patch v1'
    })

    await processTextTask(task, [])

    expect(moderateTextMock).toHaveBeenCalledWith(
      'resource',
      '标题: Patch v1 介绍: 汉化补丁'
    )
    expect(getKvMock).toHaveBeenCalledWith(
      cacheKeyOf('resource', '标题:patchv1介绍:汉化补丁')
    )
  })

  it('签名任务审 text, 暂存的 bio 原值不参与审核', async () => {
    const task = makeTask('bio', { text: '签名 text', bio: '签名  text' })

    await processTextTask(task, [])

    expect(moderateTextMock).toHaveBeenCalledWith('bio', '签名 text')
  })

  it('缺 text 的旧任务按空串处理', async () => {
    await processTextTask(makeTask('comment', {}), [])

    expect(getKvMock).toHaveBeenCalledWith(cacheKeyOf('comment', ''))
    expect(moderateTextMock).toHaveBeenCalledWith('comment', '')
  })
})

describe('载荷无法解析时转人工, 不调模型', () => {
  it.each([
    ['载荷不是对象', 'comment', 'broken'],
    ['v2 的段损坏', 'comment', { v: 2, segments: 'broken' }],
    ['载荷为 null', 'resource', null]
  ])('文本任务: %s', async (_name, contentType, payload) => {
    const task = makeTask(
      contentType,
      payload as unknown as Record<string, unknown>
    )

    await processTextTask(task, [{ pattern: 'broken', content_types: [] }])

    expect(markTaskManualMock).toHaveBeenCalledWith(1, '载荷无法解析')
    expect(applyModerationVerdictMock).not.toHaveBeenCalled()
    expect(getKvMock).not.toHaveBeenCalled()
    expect(moderateTextMock).not.toHaveBeenCalled()
  })

  it('头像任务: 缺对象 key 时不去取图', async () => {
    await processAvatarTask(makeTask('avatar', { pendingLink: 'only-this' }))

    expect(markTaskManualMock).toHaveBeenCalledWith(1, '载荷无法解析')
    expect(applyModerationVerdictMock).not.toHaveBeenCalled()
  })
})

describe('processTextTask: v2 载荷', () => {
  it('过渡期仍把双写的平铺文本交给黑名单、缓存键与模型', async () => {
    const task = makeTask('resource', {
      v: 2,
      segments: [
        { label: '标题', kind: 'plain', value: 'Patch v1' },
        { label: '介绍', kind: 'markdown-standard', value: '汉化\n补丁' }
      ],
      text: '标题: Patch v1 介绍: 汉化 补丁',
      name: 'Patch v1'
    })

    await processTextTask(task, [])

    expect(moderateTextMock).toHaveBeenCalledWith(
      'resource',
      '标题: Patch v1 介绍: 汉化 补丁'
    )
    expect(getKvMock).toHaveBeenCalledWith(
      cacheKeyOf('resource', '标题:patchv1介绍:汉化补丁')
    )
  })
})
