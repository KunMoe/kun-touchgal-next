import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { convert } from 'html-to-text'
import type { Prisma } from '~/prisma/generated/prisma/client'

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
  updated: true,
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
  // 对账脚本用于比对 PG 与索引差异的时间戳
  updated: number
  resourceUpdateTime: number
  view: number
  download: number
  favoriteCount: number
  resourceCount: number
  commentCount: number
  ratingCount: number
  avgRating: number
}

// 计数快照的 partial 文档，经 updateDocuments（PUT）定时刷入，不触发实时同步
export interface GalgameSearchCountsDoc {
  id: number
  view: number
  download: number
  favoriteCount: number
  resourceCount: number
  commentCount: number
  ratingCount: number
  avgRating: number
}

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
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
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_INTRODUCTION_MAX_LENGTH)
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
  return {
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
    updated: Math.floor(patch.updated.getTime() / 1000),
    resourceUpdateTime: Math.floor(patch.resource_update_time.getTime() / 1000),
    view: patch.view,
    download: patch.download,
    favoriteCount: patch.favorite_count,
    resourceCount: patch.resource_count,
    commentCount: patch.comment_count,
    ratingCount: patch.rating_stat?.count ?? 0,
    avgRating: patch.rating_stat?.avg_overall ?? 0
  }
}
