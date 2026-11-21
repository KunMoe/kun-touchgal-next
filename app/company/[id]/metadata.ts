import { kunPageMetadata } from '~/utils/pageMetadata'
import type { Metadata } from 'next'
import type { CompanyDetail } from '~/types/api/company'

export const generateKunMetadataTemplate = (
  company: CompanyDetail
): Metadata => {
  const created = new Date(company.created).toISOString()

  return kunPageMetadata({
    title: `所属会社为 ${company.name} 的 Galgame`,
    description: company.introduction,
    keywords: [company.name, ...company.alias],
    canonicalPath: `/company/${company.id}`,
    social: {
      article: {
        publishedTime: created,
        modifiedTime: created,
        tags: company.alias
      },
      card: 'summary'
    }
  })
}
