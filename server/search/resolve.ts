import { prisma } from '~/prisma/index'
import { termAliasFilter } from '~/server/term/match'
import { aliasLookupForms } from '~/utils/term/normalize'

// 无 id 的 tag/company 建议项按名称批量解析为 id 集合,匹配语义与 basic 引擎的
// Prisma OR 条件一致(见 server/galgame/basicSearch.ts, 两边都经 server/term/match.ts)。
// 每类型合并为单条查询,避免按建议数扇出 PG 往返;返回 名称 -> id 集合 的映射供调用方按项回填。

type NameIdMap = Map<string, number[]>

// 库里的一个别名 (或母品牌) 对应哪些输入: 与查询条件同一套大小写规则 (aliasLookupForms)
const inputsByAliasForm = (inputs: readonly string[]) => {
  const map = new Map<string, string[]>()
  for (const input of inputs) {
    for (const form of aliasLookupForms(input)) {
      map.set(form, [...(map.get(form) ?? []), input])
    }
  }
  return map
}

const appendId = (map: NameIdMap, key: string, id: number) => {
  const ids = map.get(key)
  if (ids) {
    // 一行可经 name 与 alias 同时命中同一名称,去重以对齐单条 findMany 语义
    if (!ids.includes(id)) {
      ids.push(id)
    }
  } else {
    map.set(key, [id])
  }
}

export const resolveTagIdsByNames = async (
  names: string[]
): Promise<NameIdMap> => {
  const map: NameIdMap = new Map()
  if (names.length === 0) {
    return map
  }
  const unique = [...new Set(names)]
  const nameSet = new Set(unique)
  const byAlias = inputsByAliasForm(unique)

  const tags = await prisma.patch_tag.findMany({
    where: {
      OR: [{ name: { in: unique } }, { alias: termAliasFilter(unique) }]
    },
    select: { id: true, name: true, alias: true }
  })

  for (const tag of tags) {
    if (nameSet.has(tag.name)) {
      appendId(map, tag.name, tag.id)
    }
    for (const alias of tag.alias) {
      for (const input of byAlias.get(alias) ?? []) {
        appendId(map, input, tag.id)
      }
    }
  }

  return map
}

export const resolveCompanyIdsByNames = async (
  names: string[]
): Promise<NameIdMap> => {
  const map: NameIdMap = new Map()
  if (names.length === 0) {
    return map
  }
  const unique = [...new Set(names)]
  const nameSet = new Set(unique)
  const byAlias = inputsByAliasForm(unique)

  const companies = await prisma.patch_company.findMany({
    where: {
      OR: [
        { name: { in: unique } },
        { alias: termAliasFilter(unique) },
        { parent_brand: termAliasFilter(unique) }
      ]
    },
    select: { id: true, name: true, alias: true, parent_brand: true }
  })

  for (const company of companies) {
    if (nameSet.has(company.name)) {
      appendId(map, company.name, company.id)
    }
    for (const alias of [...company.alias, ...company.parent_brand]) {
      for (const input of byAlias.get(alias) ?? []) {
        appendId(map, input, company.id)
      }
    }
  }

  return map
}
