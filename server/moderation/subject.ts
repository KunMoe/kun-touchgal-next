import type { ModerationTextType } from '~/constants/moderation'
import type { PatchResource, PatchResourceLink } from '~/types/api/patch'
import { stripInvisible } from '~/utils/text/unicode'
import {
  patchCommentCreateSchema,
  patchRatingCreateSchema,
  patchResourceCreateSchema
} from '~/validations/patch'
import { bioSchema } from '~/validations/user'

// 送审主体: 「哪些对外字段送审、字段怎样变化才重审、以什么形态交给黑名单与模型」
// 三件事共用的唯一定义。纯模块, 不得 import prisma / redis; 客户端只能 import type

// 段的形态决定 worker 怎样派生读者实际看到的文本: plain 原样展示, 两种 markdown
// 分别走评论与资源介绍的渲染管线
export type SegmentKind = 'plain' | 'markdown-comment' | 'markdown-standard'

export interface SubjectSegment {
  label: string
  kind: SegmentKind
  // 用户提交的原始值, 不做任何降噪改写
  value: string
}

export interface ModerationSubject<
  T extends ModerationTextType = ModerationTextType
> {
  contentType: T
  segments: SubjectSegment[]
}

interface AuditPolicy {
  audit: SegmentKind
  label: string
  // 该字段写入校验允许的最大长度, 送审时每段各自按它限长
  maxLength: number
}

// 上限直接读写入校验用的 Zod schema, 不手抄数字: schema 调整时这里自动跟随,
// 字段被改成没有长度上限的形状时启动即失败
const maxLengthOf = (schema: { maxLength: number | null }) => {
  if (schema.maxLength === null) {
    throw new Error('送审字段的 schema 必须声明长度上限')
  }
  return schema.maxLength
}

const resourceShape = patchResourceCreateSchema.shape

// audit    对外展示的自由文本, 送审
// deferred 对外展示的自由文本, 已分类但暂不送审
// enum     取值受枚举或固定格式约束, 不是自由文本
// system   系统生成
// internal 标识、计数、状态等内部字段
// nested   子对象, 由它自己的策略表逐字段分类
type FieldPolicy =
  AuditPolicy | 'deferred' | 'enum' | 'system' | 'internal' | 'nested'

// 以对外 DTO 的键为准穷举分类: DTO 新增字段而不在这里分类, 编译即失败
export const RESOURCE_FIELD_POLICY = {
  id: 'internal',
  name: {
    audit: 'plain',
    label: '标题',
    maxLength: maxLengthOf(resourceShape.name)
  },
  section: 'enum',
  uniqueId: 'internal',
  type: 'enum',
  language: 'enum',
  note: {
    audit: 'markdown-standard',
    label: '介绍',
    maxLength: maxLengthOf(resourceShape.note)
  },
  platform: 'enum',
  emulatorType: 'enum',
  modelName: {
    audit: 'plain',
    label: '模型型号',
    maxLength: maxLengthOf(resourceShape.modelName)
  },
  download: 'internal',
  links: 'nested',
  likeCount: 'internal',
  isLike: 'internal',
  status: 'internal',
  userId: 'internal',
  patchId: 'internal',
  created: 'internal',
  user: 'internal'
} as const satisfies Record<keyof PatchResource, FieldPolicy>

export const RESOURCE_LINK_FIELD_POLICY = {
  id: 'internal',
  storage: 'enum',
  size: 'enum',
  code: 'deferred',
  password: 'deferred',
  hash: 'system',
  content: 'deferred',
  sortOrder: 'internal',
  download: 'internal'
} as const satisfies Record<keyof PatchResourceLink, FieldPolicy>

// 策略表里标为送审的键, 就是构造器必须拿到的字段: 把某个字段改成 audit 而调用点
// 不提供它的值, 同样编译失败
type AuditedKeys<Policy> = {
  [K in keyof Policy]: Policy[K] extends AuditPolicy ? K : never
}[keyof Policy]

export type ResourceSubjectFields = Record<
  AuditedKeys<typeof RESOURCE_FIELD_POLICY>,
  string
>

// 值为空串的字段不产生段; 其余一律保留原始值 (仅把孤立代理替换为 U+FFFD,
// 否则整份载荷写不进 jsonb)
const toSegments = <Fields extends Record<string, string>>(
  policy: Record<string, FieldPolicy>,
  fields: Fields
): SubjectSegment[] =>
  Object.entries(policy).flatMap(([key, fieldPolicy]) => {
    if (typeof fieldPolicy === 'string') {
      return []
    }
    const value = fields[key].toWellFormed()
    return value
      ? [{ label: fieldPolicy.label, kind: fieldPolicy.audit, value }]
      : []
  })

const COMMENT_POLICY: AuditPolicy = {
  audit: 'markdown-comment',
  label: '评论',
  maxLength: maxLengthOf(patchCommentCreateSchema.shape.content)
}

const RATING_POLICY: AuditPolicy = {
  audit: 'plain',
  label: '评价',
  maxLength: maxLengthOf(patchRatingCreateSchema.shape.shortSummary)
}

const BIO_POLICY: AuditPolicy = {
  audit: 'plain',
  label: '签名',
  maxLength: maxLengthOf(bioSchema.shape.bio)
}

export const commentSubject = (
  content: string
): ModerationSubject<'comment'> => ({
  contentType: 'comment',
  segments: toSegments({ value: COMMENT_POLICY }, { value: content })
})

export const ratingSubject = (
  shortSummary: string
): ModerationSubject<'rating'> => ({
  contentType: 'rating',
  segments: toSegments({ value: RATING_POLICY }, { value: shortSummary })
})

export const bioSubject = (bio: string): ModerationSubject<'bio'> => ({
  contentType: 'bio',
  segments: toSegments({ value: BIO_POLICY }, { value: bio })
})

export const resourceSubject = (
  fields: ResourceSubjectFields
): ModerationSubject<'resource'> => ({
  contentType: 'resource',
  segments: toSegments(RESOURCE_FIELD_POLICY, fields)
})

const auditedPolicies = (policy: Record<string, FieldPolicy>) =>
  Object.values(policy).filter(
    (fieldPolicy): fieldPolicy is AuditPolicy => typeof fieldPolicy !== 'string'
  )

const SEGMENT_POLICIES: Record<ModerationTextType, AuditPolicy[]> = {
  comment: [COMMENT_POLICY],
  rating: [RATING_POLICY],
  bio: [BIO_POLICY],
  resource: [
    ...auditedPolicies(RESOURCE_FIELD_POLICY),
    ...auditedPolicies(RESOURCE_LINK_FIELD_POLICY)
  ]
}

// 段落库时只带标签, 上限按标签查回。查不到 (引入主体之前的旧任务只有一个「正文」段,
// 写入时已限长) 时返回 undefined, 由调用方原样使用
export const segmentMaxLength = (
  contentType: ModerationTextType,
  label: string
) =>
  SEGMENT_POLICIES[contentType].find((policy) => policy.label === label)
    ?.maxLength

// 没有任何读者可见的文字: 各段剥掉不可见字符并去首尾空白后皆空
export const isSubjectEmpty = (subject: ModerationSubject) =>
  subject.segments.every((segment) => !stripInvisible(segment.value).trim())

// 重审判据: 逐段比较原始值。任何送审字段的变化都算变化
export const subjectChanged = (
  previous: ModerationSubject,
  next: ModerationSubject
) =>
  previous.segments.length !== next.segments.length ||
  previous.segments.some((segment, index) => {
    const other = next.segments[index]
    return (
      segment.label !== other.label ||
      segment.kind !== other.kind ||
      segment.value !== other.value
    )
  })
