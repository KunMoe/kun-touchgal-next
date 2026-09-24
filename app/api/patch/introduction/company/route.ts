import * as z from 'zod'
import { kunParsePostBody, kunParsePutBody } from '~/app/api/utils/parseQuery'
import { prisma } from '~/prisma'
import { patchCompanyChangeSchema } from '~/validations/patch'
import { enqueueSearchOutbox } from '~/server/search/sync'
import { invalidateCompanyListCache } from '~/app/api/company/cache'
import { createPatchRelationHandler } from '~/app/api/patch/introduction/_relationRoute'

const handlePatchCompanyAction = (type: 'add' | 'delete') => {
  const isAdd = type === 'add'
  return async (
    input: z.infer<typeof patchCompanyChangeSchema>
  ): Promise<boolean> => {
    const { patchId, companyId } = input

    return await prisma.$transaction(async (prisma) => {
      const existing = await prisma.patch_company_relation.findMany({
        where: { patch_id: patchId, company_id: { in: companyId } },
        select: { company_id: true }
      })
      const existingIds = new Set(existing.map((r) => r.company_id))

      const affected = isAdd
        ? companyId.filter((id) => !existingIds.has(id))
        : companyId.filter((id) => existingIds.has(id))

      if (affected.length === 0) {
        return false
      }

      if (isAdd) {
        await prisma.patch_company_relation.createMany({
          data: affected.map((id) => ({
            patch_id: patchId,
            company_id: id
          }))
        })
      } else {
        await prisma.patch_company_relation.deleteMany({
          where: { patch_id: patchId, company_id: { in: affected } }
        })
      }

      // 事务性入队：与标签/会社变更原子提交，关闭崩溃丢失窗口
      await enqueueSearchOutbox(prisma, patchId)

      return true
    })
  }
}

export const POST = createPatchRelationHandler({
  schema: patchCompanyChangeSchema,
  parseBody: kunParsePostBody,
  mutate: handlePatchCompanyAction('add'),
  invalidateListCache: invalidateCompanyListCache
})

export const PUT = createPatchRelationHandler({
  schema: patchCompanyChangeSchema,
  parseBody: kunParsePutBody,
  mutate: handlePatchCompanyAction('delete'),
  invalidateListCache: invalidateCompanyListCache
})
