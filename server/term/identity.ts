import { aliasLookupForms, aliasLookupFormsOf } from '~/utils/term/normalize'
import type { Prisma } from '~/prisma/generated/prisma/client'
import type { KunTx } from '~/prisma/index'

// 写入时「一个输入串指向哪个词条 (标签 / 会社)、没有时怎样新建」只在这里: 手动标签、外部来源
// 的标签与会社、管理端的查重都经它, 不在入口各写一份比较规则。读侧的检索条件在 ./match.ts

export interface TermRef {
  id: number
  name: string
  alias: string[]
}

// 完整客户端与事务客户端都能传: 调用方决定这些语句在不在它的事务里
type Db = KunTx

interface TermFilter {
  // name 精确等于其中之一
  names: readonly string[]
  // 别名与其中之一相同; 空数组即不按别名找
  aliasForms: readonly string[]
  excludeId?: number
}

// 两张表的这几列同名同型, 条件只写一份; 各表的适配器里是字面的 Prisma 调用
const termWhere = ({ names, aliasForms, excludeId }: TermFilter) => {
  const byName = { name: { in: [...names] } }
  const match = aliasForms.length
    ? { OR: [byName, { alias: { hasSome: [...aliasForms] } }] }
    : byName
  return excludeId === undefined ? match : { id: { not: excludeId }, ...match }
}

const termSelect = { id: true, name: true, alias: true } as const

export interface TermStore<Row extends { name: string }> {
  label: '标签' | '会社'
  findMany: (db: Db, filter: TermFilter) => Promise<TermRef[]>
  findFirst: (db: Db, filter: TermFilter) => Promise<TermRef | null>
  // 返回实际插入的行数; 同名行已存在 (含并发方刚提交的) 时由 name 唯一索引跳过
  createMany: (db: Db, rows: Row[]) => Promise<number>
  findIdsByNames: (
    db: Db,
    names: readonly string[]
  ) => Promise<{ id: number; name: string }[]>
}

export const tagTerms: TermStore<Prisma.patch_tagCreateManyInput> = {
  label: '标签',
  findMany: (db, filter) =>
    db.patch_tag.findMany({
      where: termWhere(filter),
      select: termSelect,
      orderBy: { id: 'asc' }
    }),
  findFirst: (db, filter) =>
    db.patch_tag.findFirst({
      where: termWhere(filter),
      select: termSelect,
      orderBy: { id: 'asc' }
    }),
  createMany: async (db, rows) =>
    (await db.patch_tag.createMany({ data: rows, skipDuplicates: true })).count,
  findIdsByNames: (db, names) =>
    db.patch_tag.findMany({
      where: { name: { in: [...names] } },
      select: { id: true, name: true }
    })
}

export const companyTerms: TermStore<Prisma.patch_companyCreateManyInput> = {
  label: '会社',
  findMany: (db, filter) =>
    db.patch_company.findMany({
      where: termWhere(filter),
      select: termSelect,
      orderBy: { id: 'asc' }
    }),
  findFirst: (db, filter) =>
    db.patch_company.findFirst({
      where: termWhere(filter),
      select: termSelect,
      orderBy: { id: 'asc' }
    }),
  createMany: async (db, rows) =>
    (await db.patch_company.createMany({ data: rows, skipDuplicates: true }))
      .count,
  findIdsByNames: (db, names) =>
    db.patch_company.findMany({
      where: { name: { in: [...names] } },
      select: { id: true, name: true }
    })
}

// 一个输入串解析到哪个词条。名字精确匹配优先 (同一串可能既是 A 的别名又是 B 的名字);
// matchAlias 时再按别名找, 大小写规则随 aliasLookupForms, 多条命中取 id 最小的一条
export const pickTermForName = (
  input: string,
  candidates: readonly TermRef[],
  { matchAlias }: { matchAlias: boolean }
): TermRef | undefined => {
  const byName = candidates.find((term) => term.name === input)
  if (byName || !matchAlias) {
    return byName
  }
  const forms = aliasLookupForms(input)
  let picked: TermRef | undefined
  for (const term of candidates) {
    if (
      term.alias.some((alias) => forms.includes(alias)) &&
      (!picked || term.id < picked.id)
    ) {
      picked = term
    }
  }
  return picked
}

// 输入串 -> 已存在词条的 id; 没解析到的输入不在结果里, 由调用方决定是否新建。
// 外部来源的标签不按别名归并 (dlsite-tags-external-source 的裁定), 传 matchAlias: false
export const resolveExistingTerms = async <Row extends { name: string }>(
  db: Db,
  store: TermStore<Row>,
  inputs: readonly string[],
  { matchAlias }: { matchAlias: boolean }
): Promise<Map<string, number>> => {
  const resolved = new Map<string, number>()
  if (!inputs.length) {
    return resolved
  }
  const candidates = await store.findMany(db, {
    names: inputs,
    aliasForms: matchAlias ? aliasLookupFormsOf(inputs) : []
  })
  for (const input of inputs) {
    const term = pickTermForName(input, candidates, { matchAlias })
    if (term) {
      resolved.set(input, term.id)
    }
  }
  return resolved
}

// 按码元比较: 不随运行环境的 locale 变, 任何进程排出来的顺序都一样
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// 新建词条, 返回实际插入的行数。按名排序后一条语句插入: 两个并发事务引入同一批新名字时, 以
// 相同的顺序去等对方在 name 唯一索引上的条目, 不会互等。skipDuplicates 让后到者跳过已被对方
// 建好的名字 (否则撞唯一索引), 再用 readTermIds 按名回读拿到那一行。两步分开调用, 是为了让
// 调用方在回读之前记下「已经新建过」(回读失败时列表缓存照样要失效)
export const createTerms = async <Row extends { name: string }>(
  db: Db,
  store: TermStore<Row>,
  names: readonly string[],
  rowFor: (name: string) => Row
): Promise<number> => {
  if (!names.length) {
    return 0
  }
  return store.createMany(db, [...names].sort(byCodeUnit).map(rowFor))
}

// 名字 -> id, 包括并发方已提交的同名行
export const readTermIds = async <Row extends { name: string }>(
  db: Db,
  store: TermStore<Row>,
  names: readonly string[]
): Promise<Map<string, number>> => {
  if (!names.length) {
    return new Map()
  }
  const rows = await store.findIdsByNames(db, names)
  return new Map(rows.map((row) => [row.name, row.id]))
}

// 管理端新建 / 编辑词条的查重, 返回业务错误消息。新名字不得是别人的名字或别名; 新加的别名
// 不得是别人的名字或别名 (否则按别名解析时永远落到别人那里, 或与别人的别名互相争抢)。编辑时
// 只传这次新加的别名: 存量里已有的撞名不拦, 不然只改简介也存不了
export const findTermConflict = async <Row extends { name: string }>(
  db: Db,
  store: TermStore<Row>,
  {
    name,
    addedAliases,
    selfId
  }: { name: string; addedAliases: readonly string[]; selfId?: number }
): Promise<string | null> => {
  const byName = await store.findFirst(db, {
    names: [name],
    aliasForms: aliasLookupForms(name),
    excludeId: selfId
  })
  if (byName) {
    return `这个${store.label}已经存在了`
  }
  if (!addedAliases.length) {
    return null
  }
  const byAlias = await store.findFirst(db, {
    names: addedAliases,
    aliasForms: addedAliases,
    excludeId: selfId
  })
  if (!byAlias) {
    return null
  }
  const alias =
    addedAliases.find(
      (item) => item === byAlias.name || byAlias.alias.includes(item)
    ) ?? addedAliases[0]
  return `别名「${alias}」已是${store.label}「${byAlias.name}」的名字或别名`
}
