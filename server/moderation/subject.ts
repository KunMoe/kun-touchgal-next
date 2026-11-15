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
  // 同一行里别的字段决定它是否对外展示用户输入时使用; 缺省为总是送审
  when?: (row: { storage: string }) => boolean
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
const linkShape = resourceShape.links.element.shape

// audit    对外展示的自由文本, 送审
// enum     取值受枚举或固定格式约束, 不是自由文本
// system   系统生成
// internal 标识、计数、状态等内部字段
// nested   子对象, 由它自己的策略表逐字段分类
type FieldPolicy = AuditPolicy | 'enum' | 'system' | 'internal' | 'nested'

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

// ResourceSizeRegex 是 /^.{0,107}(mb|gb)$/i: 单位之前可以是任意 107 个字符
const RESOURCE_LINK_SIZE_MAX_LENGTH = 109

// 链接文本、大小、提取码、解压码向所有访客展示 (DownloadCard), 与标题、介绍一样是
// 自由文本。送审字段按这里的书写顺序出段: 链接在前, 它的大小与两个口令紧随其后
export const RESOURCE_LINK_FIELD_POLICY = {
  id: 'internal',
  storage: 'enum',
  hash: 'system',
  content: {
    audit: 'plain',
    label: '链接',
    maxLength: maxLengthOf(linkShape.content),
    // 站内存储 (s3) 的链接地址由服务端在绑定上传对象时生成, 不是用户输入
    when: (link) => link.storage !== 's3'
  },
  // 名为大小, 校验却只要求以 MB / GB 结尾: 前面写什么都行, 所以同样是自由文本
  size: {
    audit: 'plain',
    label: '大小',
    maxLength: RESOURCE_LINK_SIZE_MAX_LENGTH
  },
  code: {
    audit: 'plain',
    label: '提取码',
    maxLength: maxLengthOf(linkShape.code)
  },
  password: {
    audit: 'plain',
    label: '解压码',
    maxLength: maxLengthOf(linkShape.password)
  },
  sortOrder: 'internal',
  download: 'internal'
} as const satisfies Record<keyof PatchResourceLink, FieldPolicy>

// 策略表里标为送审的键, 就是构造器必须拿到的字段: 把某个字段改成 audit 而调用点
// 不提供它的值, 同样编译失败
type AuditedKeys<Policy> = {
  [K in keyof Policy]: Policy[K] extends AuditPolicy ? K : never
}[keyof Policy]

// storage 不送审, 但链接地址是否为用户输入取决于它
export type ResourceLinkSubjectFields = Record<
  AuditedKeys<typeof RESOURCE_LINK_FIELD_POLICY>,
  string
> & { storage: string }

export type ResourceSubjectFields = Record<
  AuditedKeys<typeof RESOURCE_FIELD_POLICY>,
  string
> & { links: ResourceLinkSubjectFields[] }

// 值为空串的字段不产生段; 其余一律保留原始值 (仅把孤立代理替换为 U+FFFD,
// 否则整份载荷写不进 jsonb)。labelSuffix 用来给多条链接的字段编号
const toSegments = (
  policy: Record<string, FieldPolicy>,
  fields: Record<string, string>,
  labelSuffix = ''
): SubjectSegment[] =>
  Object.entries(policy).flatMap(([key, fieldPolicy]) => {
    if (typeof fieldPolicy === 'string') {
      return []
    }
    if (fieldPolicy.when && !fieldPolicy.when({ storage: fields.storage })) {
      return []
    }
    const value = fields[key].toWellFormed()
    return value
      ? [
          {
            label: `${fieldPolicy.label}${labelSuffix}`,
            kind: fieldPolicy.audit,
            value
          }
        ]
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

// 只有一条链接时字段名不带序号; 多条时依次为「链接 1」「提取码 1」「链接 2」…
const linkLabelSuffix = (index: number, total: number) =>
  total > 1 ? ` ${index + 1}` : ''

export const resourceSubject = ({
  links,
  ...fields
}: ResourceSubjectFields): ModerationSubject<'resource'> => ({
  contentType: 'resource',
  segments: [
    ...toSegments(RESOURCE_FIELD_POLICY, fields),
    ...links.flatMap((link, index) =>
      toSegments(
        RESOURCE_LINK_FIELD_POLICY,
        link,
        linkLabelSuffix(index, links.length)
      )
    )
  ]
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

// 段落库时只带标签, 上限按标签查回 (多条链接的字段名带序号, 查之前去掉)。查不到
// (引入主体之前的旧任务只有一个「正文」段, 写入时已限长) 时返回 undefined, 由调用方
// 原样使用
export const segmentMaxLength = (
  contentType: ModerationTextType,
  label: string
) => {
  const field = label.replace(/ \d+$/, '')
  return SEGMENT_POLICIES[contentType].find((policy) => policy.label === field)
    ?.maxLength
}

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
