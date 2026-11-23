import { createHash } from 'crypto'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { convert } from 'html-to-text'
import { kunListItemHandler } from '~/app/api/utils/render/listItemHandler'
import type { Prisma } from '~/prisma/generated/prisma/client'
import { sliceCodePoints } from '~/utils/text/unicode'

export const SEARCH_INTRODUCTION_MAX_LENGTH = 2000

// 全量导入与增量同步共用的唯一取数投影，防止两处逻辑漂移
export const PATCH_SEARCH_SELECT = {
  id: true,
  unique_id: true,
  name: true,
  banner: true,
  vndb_id: true,
  vndb_relation_id: true,
  dlsite_code: true,
  introduction: true,
  released: true,
  released_sort: true,
  content_limit: true,
  type: true,
  language: true,
  platform: true,
  view: true,
  download: true,
  favorite_count: true,
  resource_count: true,
  comment_count: true,
  created: true,
  resource_update_time: true,
  alias: { select: { name: true } },
  tag: { select: { tag: { select: { id: true, name: true } } } },
  company: { select: { company: { select: { id: true, name: true } } } },
  rating_stat: { select: { avg_overall: true, count: true } }
} satisfies Prisma.patchSelect

export type PatchSearchPayload = Prisma.patchGetPayload<{
  select: typeof PATCH_SEARCH_SELECT
}>

export interface GalgameSearchDoc {
  id: number
  uniqueId: string
  name: string
  banner: string
  alias: string[]
  tag: string[]
  company: string[]
  introduction: string
  vndbId: string | null
  vndbRelationId: string | null
  dlsiteCode: string | null
  tagIds: number[]
  companyIds: number[]
  type: string[]
  language: string[]
  platform: string[]
  contentLimit: string
  releasedYear: string
  releasedMonth: string | null
  // 触发器维护的 YYYYMMDD 排序键，无法解析的日期为 null
  releasedSort: number | null
  created: number
  resourceUpdateTime: number
  view: number
  download: number
  favoriteCount: number
  resourceCount: number
  commentCount: number
  ratingCount: number
  avgRating: number
  // 文档摘要 (computeSearchDocHash)，对账拿它判断索引里这份文档是否过时；不检索、不过滤、不排序
  docHash: string
}

// 计数字段：变化只影响排序 (以及 ratingCount 过滤)，不触发实时同步，由计数刷新任务
// (searchCountsRefreshTask) 按快照差量定时写入。这张表同时定计数指纹的字段与顺序、计数
// partial 文档的形状、文档摘要的剔除项
export const SEARCH_COUNT_FIELDS = [
  'view',
  'download',
  'favoriteCount',
  'resourceCount',
  'commentCount',
  'ratingCount',
  'avgRating'
] as const satisfies readonly (keyof GalgameSearchDoc)[]

// 计数快照的 partial 文档，经 updateDocuments（PUT）定时刷入
export type GalgameSearchCountsDoc = Pick<
  GalgameSearchDoc,
  'id' | (typeof SEARCH_COUNT_FIELDS)[number]
>

const SEARCH_DOC_HASH_EXCLUDED = new Set<string>([
  ...SEARCH_COUNT_FIELDS,
  'docHash'
])

// 摘要取自构建出的文档而不是 PG 载荷：别名 / 标签 / 会社关联与改名、构建器自身或依赖
// (remark、html-to-text) 输出的变化都会改变它，不用维护构建器版本号，也不用另抄一份 PG
// 字段清单。计数字段由计数刷新任务单独写入，不进摘要。关联查询没有 orderBy，数组按元素
// 排序后再算，返回顺序变了不算过时
export const computeSearchDocHash = (
  doc: Omit<GalgameSearchDoc, 'docHash'>
) => {
  const entries = Object.entries(doc)
    .filter(([key]) => !SEARCH_DOC_HASH_EXCLUDED.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.map((item) => JSON.stringify(item)).sort()
        : value
    ])
  return createHash('sha1').update(JSON.stringify(entries)).digest('hex')
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { handlers: { listItem: kunListItemHandler } })
  .use(rehypeStringify)
  .freeze()

export const markdownToSearchText = async (markdown: string) => {
  if (!markdown) {
    return ''
  }
  const html = String(await markdownProcessor.process(markdown))
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } }
    ]
  })
  // 按码点截断：按 UTF-16 码元截断会在代理对中间切开，带孤立代理的请求体被 Meilisearch
  // 判为非法 JSON，这份文档的每一次写入都会失败
  return sliceCodePoints(
    text.replace(/\s+/g, ' ').trim(),
    SEARCH_INTRODUCTION_MAX_LENGTH
  )
}

// released 为字符串：'YYYY-MM-DD' | 'future' | 'unknown'；
// 无法解析的值映射为 ''，使其不命中任何年份筛选，与旧 startsWith 语义一致
export const parseReleasedDate = (released: string) => {
  if (released === 'future' || released === 'unknown') {
    return { releasedYear: released, releasedMonth: null }
  }
  const match = /^(\d{4})(?:-(\d{2}))?/.exec(released)
  if (!match) {
    return { releasedYear: '', releasedMonth: null }
  }
  return { releasedYear: match[1], releasedMonth: match[2] ?? null }
}

export const patchToSearchDoc = async (
  patch: PatchSearchPayload
): Promise<GalgameSearchDoc> => {
  const { releasedYear, releasedMonth } = parseReleasedDate(patch.released)
  const doc: Omit<GalgameSearchDoc, 'docHash'> = {
    id: patch.id,
    uniqueId: patch.unique_id,
    name: patch.name,
    banner: patch.banner,
    alias: patch.alias.map((a) => a.name),
    tag: patch.tag.map((t) => t.tag.name),
    company: patch.company.map((c) => c.company.name),
    introduction: await markdownToSearchText(patch.introduction),
    vndbId: patch.vndb_id,
    vndbRelationId: patch.vndb_relation_id,
    dlsiteCode: patch.dlsite_code,
    tagIds: patch.tag.map((t) => t.tag.id),
    companyIds: patch.company.map((c) => c.company.id),
    type: patch.type,
    language: patch.language,
    platform: patch.platform,
    contentLimit: patch.content_limit,
    releasedYear,
    releasedMonth,
    releasedSort: patch.released_sort,
    created: Math.floor(patch.created.getTime() / 1000),
    resourceUpdateTime: Math.floor(patch.resource_update_time.getTime() / 1000),
    view: patch.view,
    download: patch.download,
    favoriteCount: patch.favorite_count,
    resourceCount: patch.resource_count,
    commentCount: patch.comment_count,
    ratingCount: patch.rating_stat?.count ?? 0,
    avgRating: patch.rating_stat?.avg_overall ?? 0
  }
  return { ...doc, docHash: computeSearchDocHash(doc) }
}
