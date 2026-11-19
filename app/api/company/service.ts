import * as z from 'zod'
import { prisma } from '~/prisma'
import { getCompanyByIdSchema } from '~/validations/company'

// 会社不存在时返回 null: 文案在路由边界产生, 页面读取器调 notFound
export const getCompanyById = async (
  input: z.infer<typeof getCompanyByIdSchema>
) => {
  const { companyId } = input

  return prisma.patch_company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      count: true,
      alias: true,
      introduction: true,
      primary_language: true,
      official_website: true,
      parent_brand: true,
      created: true,
      user: {
        select: {
          id: true,
          name: true,
          avatar: true
        }
      }
    }
  })
}
