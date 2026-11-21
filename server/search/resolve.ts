import { prisma } from '~/prisma/index'

// 无 id 的 tag/company 建议项按名称批量解析为 id 集合,匹配语义与 basic 引擎的
// Prisma OR 条件一致(见 server/galgame/basicSearch.ts)。每类型合并为单条查询,
// 避免按建议数扇出 PG 往返;返回 名称 -> id 集合 的映射供调用方按项回填。

type NameIdMap = Map<string, number[]>

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

  const tags = await prisma.patch_tag.findMany({
    where: { OR: [{ name: { in: unique } }, { alias: { hasSome: unique } }] },
    select: { id: true, name: true, alias: true }
  })

  for (const tag of tags) {
    if (nameSet.has(tag.name)) {
      appendId(map, tag.name, tag.id)
    }
    for (const alias of tag.alias) {
      if (nameSet.has(alias)) {
        appendId(map, alias, tag.id)
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

  const companies = await prisma.patch_company.findMany({
    where: {
      OR: [
        { name: { in: unique } },
        { alias: { hasSome: unique } },
        { parent_brand: { hasSome: unique } }
      ]
    },
    select: { id: true, name: true, alias: true, parent_brand: true }
  })

  for (const company of companies) {
    if (nameSet.has(company.name)) {
      appendId(map, company.name, company.id)
    }
    for (const alias of company.alias) {
      if (nameSet.has(alias)) {
        appendId(map, alias, company.id)
      }
    }
    for (const brand of company.parent_brand) {
      if (nameSet.has(brand)) {
        appendId(map, brand, company.id)
      }
    }
  }

  return map
}
