import * as z from 'zod'
import { prisma } from '~/prisma'
import { getCompanyByIdSchema } from '~/validations/company'

export const getCompanyById = async (
  input: z.infer<typeof getCompanyByIdSchema>
) => {
  const { companyId } = input

  const company = await prisma.patch_company.findUnique({
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
  if (!company) {
    return '未找到公司'
  }

  return company
}
