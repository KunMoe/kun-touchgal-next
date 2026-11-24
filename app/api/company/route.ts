import * as z from 'zod'
import { prisma } from '~/prisma'
import { Prisma } from '~/prisma/generated/prisma/client'
import { kunTx } from '~/server/db/tx'
import { recordKunChanges } from '~/server/cache/publish'
import {
  createCompanySchema,
  getCompanyByIdSchema,
  updateCompanySchema
} from '~/validations/company'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { companyTerms, findTermConflict } from '~/server/term/identity'
import { normalizeAliasList } from '~/utils/term/normalize'
import { getCompanyById } from './service'
import { invalidateCompanyListCache } from './cache'
import {
  enqueueSearchOutboxBatch,
  kickSearchOutboxDrain
} from '~/server/search/sync'

export const GET = kunRoute.get({
  auth: 'public',
  input: getCompanyByIdSchema,
  handler: async ({ input }) => (await getCompanyById(input)) ?? '未找到公司'
})

const rewriteCompany = async (input: z.infer<typeof updateCompanySchema>) => {
  const {
    companyId,
    name,
    primary_language,
    introduction = '',
    alias = [],
    official_website = [],
    parent_brand = []
  } = input

  const currentCompany = await prisma.patch_company.findUnique({
    where: { id: companyId },
    select: { name: true, alias: true }
  })
  // 只查这次新加的别名: 存量里已经撞上别人的不拦, 否则只改简介也存不了
  const currentAliases = new Set(
    normalizeAliasList(currentCompany?.alias ?? [])
  )
  const conflict = await findTermConflict(prisma, companyTerms, {
    name,
    addedAliases: alias.filter((item) => !currentAliases.has(item)),
    selfId: companyId
  })
  if (conflict) {
    return conflict
  }

  // 索引文档内嵌会社名，改名须重建全部关联 patch 的文档；仅改简介/别名不入文档
  //（别名解析在查询期实时读库），无需入队
  const shouldSyncSearch = !!currentCompany && currentCompany.name !== name

  // 事务性入队：会社变更与写出箱入队原子提交，关闭崩溃丢失窗口
  const result = await kunTx(
    'company.update',
    async (ctx) => {
      const { tx } = ctx
      const newCompany = await tx.patch_company.update({
        where: { id: companyId },
        data: {
          name,
          introduction,
          alias,
          primary_language,
          official_website,
          parent_brand
        },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              avatar: true
            }
          }
        }
      })
      const patchIds = shouldSyncSearch
        ? (
            await tx.patch_company_relation.findMany({
              where: { company_id: companyId },
              select: { patch_id: true }
            })
          ).map((relation) => relation.patch_id)
        : []
      await enqueueSearchOutboxBatch(tx, patchIds)
      if (shouldSyncSearch) {
        recordKunChanges(ctx, [
          { kind: 'taxonomyRenamed', taxonomy: 'company', patchIds }
        ])
      }
      return { newCompany, patchIds }
    },
    // name 唯一索引兜底并发改名
    { violations: { P2002: '这个会社已经存在了' } }
  )
  if (typeof result === 'string') {
    return result
  }
  const { newCompany, patchIds } = result
  await invalidateCompanyListCache()
  if (patchIds.length > 0) {
    kickSearchOutboxDrain()
  }

  return newCompany
}

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'company.manage',
  input: updateCompanySchema,
  handler: ({ input }) => rewriteCompany(input)
})

const createCompany = async (
  input: z.infer<typeof createCompanySchema>,
  uid: number
) => {
  const {
    name,
    primary_language,
    introduction = '',
    alias = [],
    official_website = [],
    parent_brand = []
  } = input

  const conflict = await findTermConflict(prisma, companyTerms, {
    name,
    addedAliases: alias
  })
  if (conflict) {
    return conflict
  }

  try {
    const newCompany = await prisma.patch_company.create({
      data: {
        user_id: uid,
        name,
        introduction,
        alias,
        primary_language,
        official_website,
        parent_brand
      },
      select: {
        id: true,
        name: true,
        count: true,
        alias: true
      }
    })
    await invalidateCompanyListCache()

    return newCompany
  } catch (error) {
    // name 唯一索引兜底并发创建
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return '这个会社已经存在了'
    }
    throw error
  }
}

export const POST = kunRoute.post({
  auth: 'user',
  capability: 'company.manage',
  input: createCompanySchema,
  handler: ({ input, actor }) => createCompany(input, actor.uid)
})

export const DELETE = kunRoute.delete({
  auth: 'user',
  capability: 'company.manage',
  input: getCompanyByIdSchema,
  handler: async ({ input }) => {
    // 索引文档内嵌会社名与 companyIds，FK Cascade 会随删除清掉关系行，因此关联
    // patch 必须在删除前读取；删除与入队原子提交，消费者按 DB 最新状态重建文档
    let patchIds: number[] | string
    try {
      patchIds = await kunTx('company.delete', async (ctx) => {
        const { tx } = ctx
        const relations = await tx.patch_company_relation.findMany({
          where: { company_id: input.companyId },
          select: { patch_id: true }
        })
        await tx.patch_company.delete({ where: { id: input.companyId } })
        const ids = relations.map((relation) => relation.patch_id)
        await enqueueSearchOutboxBatch(tx, ids)
        recordKunChanges(ctx, [
          { kind: 'taxonomyDeleted', taxonomy: 'company', patchIds: ids }
        ])
        return ids
      })
    } catch {
      return '未找到对应的会社'
    }
    if (typeof patchIds === 'string') {
      return patchIds
    }
    await invalidateCompanyListCache()
    if (patchIds.length > 0) {
      kickSearchOutboxDrain()
    }

    return {}
  }
})
