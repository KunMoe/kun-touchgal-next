import { prisma } from '~/prisma/index'
import { Prisma } from '~/prisma/generated/prisma/client'
import { GalgameCardSelectField, toGalgameCard } from '~/constants/api/select'
import { companyNameMatchWhere, tagNameMatchWhere } from '~/server/term/match'
import {
  buildGalgameDateFilter,
  buildGalgameOrderBy,
  buildGalgameWhere
} from '~/app/api/utils/galgameQuery'
import {
  toPatchWhere,
  type PatchVisibility
} from '~/server/viewer/patchVisibility'
import type { GalgameListResponse } from '~/app/api/utils/galgameListCache'
import type {
  GalgameKeywordSearchSpec,
  GalgameSuggestionRef
} from '~/server/galgame/search'

// 关键词搜索的 basic 引擎: Meilisearch 未启用时的唯一实现, 启用时是它出故障后的降级。
// 它与 Meilisearch 不等价, 也不打算做成等价 (响应里的 engine 字段标明用的是哪一个):
// - 关键词是 ILIKE 子串匹配: 不分词、不容错、不处理停用词; 多个关键词取交集
// - 严格按所选排序, 没有相关度, 也没有相关度阈值
// - 关键词恒匹配标题与外部 ID, 简介 / 别名 / 标签名按检索选项; 不匹配会社名
// - 外部 ID (vndb / dlsite) 是区分大小写的整串相等
// - 简介匹配的是库里的 markdown 原文, 不是渲染后的文字

const insensitive = Prisma.QueryMode.insensitive

const keywordIncluded = (
  keyword: string,
  searchIn: GalgameKeywordSearchSpec['searchIn']
): Prisma.patchWhereInput => ({
  OR: [
    { name: { contains: keyword, mode: insensitive } },
    { vndb_id: keyword },
    { vndb_relation_id: keyword },
    { dlsite_code: keyword },
    ...(searchIn.introduction
      ? [{ introduction: { contains: keyword, mode: insensitive } }]
      : []),
    ...(searchIn.alias
      ? [
          {
            alias: { some: { name: { contains: keyword, mode: insensitive } } }
          }
        ]
      : []),
    ...(searchIn.tag
      ? [
          {
            tag: {
              some: { tag: { name: { contains: keyword, mode: insensitive } } }
            }
          }
        ]
      : [])
  ]
})

const keywordExcluded = (
  keyword: string,
  searchIn: GalgameKeywordSearchSpec['searchIn']
): Prisma.patchWhereInput => ({
  AND: [
    { NOT: { name: { contains: keyword, mode: insensitive } } },
    { OR: [{ vndb_id: null }, { vndb_id: { not: keyword } }] },
    {
      OR: [{ vndb_relation_id: null }, { vndb_relation_id: { not: keyword } }]
    },
    { OR: [{ dlsite_code: null }, { dlsite_code: { not: keyword } }] },
    ...(searchIn.introduction
      ? [{ NOT: { introduction: { contains: keyword, mode: insensitive } } }]
      : []),
    ...(searchIn.alias
      ? [
          {
            alias: { none: { name: { contains: keyword, mode: insensitive } } }
          }
        ]
      : []),
    ...(searchIn.tag
      ? [
          {
            tag: {
              none: { tag: { name: { contains: keyword, mode: insensitive } } }
            }
          }
        ]
      : [])
  ]
})

// 带 id 的建议项按 id 匹配; 不带 id 的按名称, 名称也认别名 (会社另认母品牌)
const hasTag = (tag: GalgameSuggestionRef): Prisma.patchWhereInput => ({
  tag: {
    some:
      typeof tag.id === 'number'
        ? { tag_id: tag.id }
        : { tag: tagNameMatchWhere(tag.name) }
  }
})

const hasCompany = (company: GalgameSuggestionRef): Prisma.patchWhereInput => ({
  company: {
    some:
      typeof company.id === 'number'
        ? { company_id: company.id }
        : { company: companyNameMatchWhere(company.name) }
  }
})

export const basicKeywordSearch = async (
  spec: GalgameKeywordSearchSpec,
  visibility: PatchVisibility
): Promise<GalgameListResponse> => {
  const { include, exclude, searchIn, filter, sort, page, limit } = spec
  const visibilityWhere = toPatchWhere(visibility)

  const where: Prisma.patchWhereInput = {
    AND: [
      ...include.keywords.map((keyword) => keywordIncluded(keyword, searchIn)),
      visibilityWhere,
      ...include.tags.map(hasTag),
      ...include.companies.map(hasCompany),
      ...exclude.keywords.map((keyword) => keywordExcluded(keyword, searchIn)),
      ...exclude.tags.map((tag) => ({ NOT: hasTag(tag) })),
      ...exclude.companies.map((company) => ({ NOT: hasCompany(company) }))
    ],
    ...buildGalgameDateFilter(filter.years, filter.months),
    ...buildGalgameWhere({
      selectedType: filter.type,
      selectedLanguage: filter.language,
      selectedPlatform: filter.platform,
      minRatingCount: filter.minRatingCount,
      visibilityWhere
    })
  }

  const [data, total] = await Promise.all([
    prisma.patch.findMany({
      take: limit,
      skip: (page - 1) * limit,
      orderBy: buildGalgameOrderBy(sort.field, sort.order),
      where,
      select: GalgameCardSelectField
    }),
    prisma.patch.count({ where })
  ])

  return { galgames: data.map(toGalgameCard), total }
}
