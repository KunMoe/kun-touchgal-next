import * as z from 'zod'
import { MODERATION_TEXT_CONTENT_TYPE } from '~/constants/moderation'
import type { ModerationTextType } from '~/constants/moderation'
import { prepareModerationText } from './prefilter'
import type { ModerationSubject, SubjectSegment } from './subject'

// moderation_task.payload 的唯一编解码点。载荷形状由 content_type 决定, 读侧一律经
// decodeModerationTask, 不再各自 `as unknown as`。客户端只能 import type

// 入队时随主体一起落库、裁决落地时要用的附带值
export interface TextTaskExtras {
  comment: Record<never, never>
  rating: Record<never, never>
  // 拒绝通知里引用的资源名
  resource: { name: string }
  // 待生效的新签名, 通过审核后才写入 user 表
  bio: { bio: string }
}

const avatarPayloadSchema = z.object({
  pendingKey: z.string(),
  pendingMiniKey: z.string(),
  avatarKey: z.string(),
  avatarMiniKey: z.string(),
  // versioned mini avatar URL written to user.avatar on approval
  avatarLink: z.string(),
  // staging URL shown to the author while the review is pending
  pendingLink: z.string(),
  // 送审对象的永久留档 URL, 供管理队列在裁决后回看; 留档功能上线前的旧任务无此字段
  archiveLink: z.string().optional()
})

export type ModerationAvatarPayload = z.infer<typeof avatarPayloadSchema>

type TextTaskBody = {
  [T in ModerationTextType]: {
    contentType: T
    subject: ModerationSubject<T>
  } & TextTaskExtras[T]
}[ModerationTextType]

export type ModerationTaskBody =
  TextTaskBody | { contentType: 'avatar'; payload: ModerationAvatarPayload }

const segmentSchema = z.object({
  label: z.string(),
  kind: z.enum(['plain', 'markdown-comment', 'markdown-standard']),
  value: z.string()
})

const textExtrasShape = {
  name: z.string().nullish(),
  bio: z.string().nullish()
}

const textPayloadV2Schema = z.object({
  v: z.literal(2),
  segments: z.array(segmentSchema),
  // 过渡期双写的旧平铺文本, 换封装后停止写入
  text: z.string().nullish(),
  ...textExtrasShape
})

// v1 是引入主体之前的形状: 只有写入时预处理过的平铺文本。长期保留, 管理端要展示
// 历史任务。v 必须缺席, 否则损坏的 v2 载荷会被当成空的 v1 静默放过
const textPayloadV1Schema = z
  .object({
    v: z.undefined().optional(),
    text: z.string().nullish(),
    ...textExtrasShape
  })
  .transform((payload) => ({
    ...payload,
    v: 2 as const,
    text: payload.text ?? '',
    segments: payload.text
      ? [{ label: '正文', kind: 'plain' as const, value: payload.text }]
      : []
  }))

const textPayloadSchema = z.union([textPayloadV2Schema, textPayloadV1Schema])

export const MODERATION_PAYLOAD_UNREADABLE = '载荷无法解析'

// 过渡期: 重建引入主体之前的平铺送审文本, 让模型输入与缓存键逐字不变
const legacyModerationText = (subject: ModerationSubject) => {
  if (subject.contentType !== 'resource') {
    return subject.segments[0]?.value ?? ''
  }
  const valueOf = (label: string) =>
    subject.segments.find((segment) => segment.label === label)?.value ?? ''
  const modelName = valueOf('模型型号')
  return `标题: ${valueOf('标题')}\n介绍: ${valueOf('介绍')}${modelName ? `\n模型型号: ${modelName}` : ''}`
}

const legacyPayloadText = (subject: ModerationSubject) =>
  prepareModerationText(legacyModerationText(subject))

export const encodeModerationPayload = (body: ModerationTaskBody) => {
  if (body.contentType === 'avatar') {
    return body.payload
  }
  return {
    v: 2,
    segments: body.subject.segments,
    text: legacyPayloadText(body.subject),
    // 附带值与各段一样要 well-formed: 一个孤立代理就会让整份载荷写不进 jsonb
    ...('name' in body ? { name: body.name.toWellFormed() } : {}),
    ...('bio' in body ? { bio: body.bio.toWellFormed() } : {})
  }
}

export type DecodedModerationTask =
  | { contentType: 'avatar'; payload: ModerationAvatarPayload }
  | {
      contentType: ModerationTextType
      segments: SubjectSegment[]
      // 交给黑名单与模型的平铺文本
      text: string
      name?: string
      bio?: string
    }

const isTextType = (contentType: string): contentType is ModerationTextType =>
  (MODERATION_TEXT_CONTENT_TYPE as readonly string[]).includes(contentType)

// 解不出来时返回 null: worker 转人工, 管理列表渲染占位。对存量宽容 —— 缺 text 的
// 旧任务按空串处理, 与引入编解码之前的 `?? ''` 一致
export const decodeModerationTask = (task: {
  content_type: string
  payload: unknown
}): DecodedModerationTask | null => {
  if (task.content_type === 'avatar') {
    const parsed = avatarPayloadSchema.safeParse(task.payload)
    return parsed.success
      ? { contentType: 'avatar', payload: parsed.data }
      : null
  }
  if (!isTextType(task.content_type)) {
    return null
  }
  const parsed = textPayloadSchema.safeParse(task.payload)
  if (!parsed.success) {
    return null
  }
  const { segments, text, name, bio } = parsed.data
  return {
    contentType: task.content_type,
    segments,
    text:
      text ?? legacyPayloadText({ contentType: task.content_type, segments }),
    ...(name != null ? { name } : {}),
    ...(bio != null ? { bio } : {})
  }
}
