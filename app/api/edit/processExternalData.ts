import { prisma } from '~/prisma/index'
import { saveManualTagChange } from './batchTag'
import { invalidateCompanyListCache } from '~/app/api/company/cache'
import { invalidateTagListCache } from '~/app/api/tag/cache'
import { enqueueSearchOutbox } from '~/server/search/sync'
import {
  companyTerms,
  createTerms,
  readTermIds,
  resolveExistingTerms,
  tagTerms
} from '~/server/term/identity'
import type { ManualTagChange } from './batchTag'

interface SubmittedExternalData {
  vndbTags: string[]
  vndbDevelopers: string[]
  bangumiTags: string[]
  bangumiDevelopers: string[]
  steamTags: string[]
  steamDevelopers: string[]
  dlsiteTags: string[]
  dlsiteCircleName: string
  dlsiteCircleLink: string
}
interface ExternalDataMutationState {
  tagChanged: boolean
  companyChanged: boolean
}

const ensureTagsWithSources = async (
  patchId: number,
  tagSources: { names: string[]; source: string }[],
  uid: number,
  mutationState: ExternalDataMutationState
) => {
  const tagSourceByName = new Map<string, string>()

  for (const { names, source } of tagSources) {
    for (const name of names) {
      if (name && !tagSourceByName.has(name)) {
        tagSourceByName.set(name, source)
      }
    }
  }

  // 超出 name VarChar(107) 的标签单独丢弃,避免一条坏名使整批 createMany
  // 失败进而丢掉其余来源的全部关联
  const validTags = [...tagSourceByName.keys()].filter((n) => n.length <= 107)
  if (!validTags.length) return false

  // 外部来源的标签只按名字精确匹配、不按别名归并 (dlsite-tags-external-source 的裁定)
  const existing = await resolveExistingTerms(prisma, tagTerms, validTags, {
    matchAlias: false
  })
  const tagsToCreate = validTags.filter((n) => !existing.has(n))
  if (tagsToCreate.length) {
    await createTerms(prisma, tagTerms, tagsToCreate, (name) => ({
      name,
      user_id: uid,
      source: tagSourceByName.get(name) ?? 'self'
    }))
    mutationState.tagChanged = true
  }
  const created = await readTermIds(prisma, tagTerms, tagsToCreate)
  const tagIds = [...new Set([...existing.values(), ...created.values()])]

  if (!tagIds.length) return tagsToCreate.length > 0

  const existingRelations = await prisma.patch_tag_relation.findMany({
    where: { patch_id: patchId, tag_id: { in: tagIds } },
    select: { tag_id: true }
  })
  const existingRelationIds = new Set(existingRelations.map((r) => r.tag_id))
  const newTagIds = tagIds.filter((id) => !existingRelationIds.has(id))

  if (newTagIds.length) {
    await prisma.patch_tag_relation.createMany({
      data: newTagIds.map((tagId) => ({ patch_id: patchId, tag_id: tagId })),
      skipDuplicates: true
    })
    mutationState.tagChanged = true
  }

  return tagsToCreate.length > 0 || newTagIds.length > 0
}

export const ensureCompanies = async (
  patchId: number,
  names: string[],
  uid: number,
  mutationState: ExternalDataMutationState,
  officialWebsiteByName: Map<string, string[]>
) => {
  // 超出 name VarChar(107) 的名字单独丢弃,避免一条坏名使整批 createMany
  // 失败进而丢掉其余来源的全部关联
  const validNames = [
    ...new Set(names.map((n) => n.trim()).filter(Boolean))
  ].filter((n) => n.length <= 107)
  if (!validNames.length) return false

  // 来源给的名字可能是存量会社的别名 (例如 Bangumi 的原文名): 名字优先、再按别名归并,
  // 命中就只关联、不新建重复会社。母品牌是检索的召回语义, 这里不认
  const existing = await resolveExistingTerms(
    prisma,
    companyTerms,
    validNames,
    { matchAlias: true }
  )
  const toCreate = validNames.filter((n) => !existing.has(n))
  // skipDuplicates 依赖 patch_company_name_key 唯一索引兜底并发创建
  const createdCount = await createTerms(
    prisma,
    companyTerms,
    toCreate,
    (name) => ({
      name,
      introduction: '',
      count: 0,
      primary_language: [],
      official_website: officialWebsiteByName.get(name) ?? [],
      parent_brand: [],
      alias: [],
      user_id: uid
    })
  )
  if (createdCount) {
    mutationState.companyChanged = true
  }

  const created = await readTermIds(prisma, companyTerms, toCreate)
  const companyIds = [...new Set([...existing.values(), ...created.values()])]

  if (!companyIds.length) return createdCount > 0

  const insertedRelations = await prisma.patch_company_relation.createMany({
    data: companyIds.map((companyId) => ({
      patch_id: patchId,
      company_id: companyId
    })),
    skipDuplicates: true
  })

  if (insertedRelations.count) {
    mutationState.companyChanged = true
  }

  return createdCount > 0 || insertedRelations.count > 0
}

export const processSubmittedExternalData = async (
  patchId: number,
  data: SubmittedExternalData,
  tagChange: ManualTagChange,
  uid: number
) => {
  // 空差量就是不动 (不开事务), 不再靠「数组为空」猜调用方是想清空还是没有意图
  const manualTags = await saveManualTagChange(patchId, tagChange, uid)
  const mutationState: ExternalDataMutationState = {
    tagChanged: manualTags.changed,
    companyChanged: false
  }

  const tagTask = ensureTagsWithSources(
    patchId,
    [
      { names: data.vndbTags, source: 'vndb' },
      { names: data.bangumiTags, source: 'bangumi' },
      { names: data.steamTags, source: 'steam' },
      { names: data.dlsiteTags, source: 'dlsite' }
    ],
    uid,
    mutationState
  )

  // 跨来源合并去重后单次处理,避免多来源同名会社并发重复创建
  const dlsiteCircleName = data.dlsiteCircleName.trim()
  const dlsiteCircleLink = data.dlsiteCircleLink.trim()
  const developerNames = [
    ...data.vndbDevelopers,
    ...data.bangumiDevelopers,
    ...data.steamDevelopers,
    ...(dlsiteCircleName ? [dlsiteCircleName] : [])
  ]
  const officialWebsiteByName = new Map<string, string[]>()
  if (dlsiteCircleName && dlsiteCircleLink) {
    officialWebsiteByName.set(dlsiteCircleName, [dlsiteCircleLink])
  }

  const companyTask = developerNames.length
    ? ensureCompanies(
        patchId,
        developerNames,
        uid,
        mutationState,
        officialWebsiteByName
      )
    : null

  // best-effort: patch 主事务已提交, 上抛只会让用户重试撞 P2002; 但 rejected 必须留痕,
  // 否则外部标签/会社静默缺失、排障无迹 (82aab687 曾为消 lint 告警删掉此日志)
  const tasks = [
    ['tag', tagTask],
    ['company', companyTask]
  ] as const
  const results = await Promise.allSettled(tasks.map(([, task]) => task))
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      // eslint-disable-next-line no-console
      console.error(
        `Failed to process external ${tasks[index][0]} data for patch ${patchId}:`,
        result.reason
      )
    }
  })

  // 写完之后入搜索出箱归这里, 不归调用方: 调用方各自补的时候, 有整套漏掉的, 也有排在调用
  // 之前的 (drain 恰在两者之间消费, 之后写入的标签与会社就进不了索引, 对账只比 updated)。
  // 无条件入队, 顺带收尾调用方在此之前写的别名与字段; 调用方返回之后只需 kick 一次消费。
  // 与上面同理不上抛, 失败留痕
  await enqueueSearchOutbox(prisma, patchId).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`Failed to enqueue search sync for patch ${patchId}:`, error)
  })

  await Promise.all([
    mutationState.tagChanged ? invalidateTagListCache() : Promise.resolve(),
    mutationState.companyChanged
      ? invalidateCompanyListCache()
      : Promise.resolve()
  ])
}
