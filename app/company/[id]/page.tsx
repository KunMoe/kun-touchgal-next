import { generateKunMetadataTemplate } from './metadata'
import { CompanyDetailContainer } from '~/components/company/detail/Container'
import {
  kunGetCompanyByIdActions,
  kunGetCompanyPageDataActions
} from './actions'
import { ErrorComponent } from '~/components/error/ErrorComponent'
import { KunBreadcrumbTitle } from '~/components/kun/BreadcrumbTitle'
import type { SortField, SortOrder } from '~/components/galgame/_sort'
import type { Metadata } from 'next'
import {
  DEFAULT_GALGAME_FILTER_VALUE,
  DEFAULT_GALGAME_MONTH_STRING,
  DEFAULT_GALGAME_SORT_FIELD,
  DEFAULT_GALGAME_SORT_ORDER,
  DEFAULT_TAG_COMPANY_MIN_RATING_COUNT,
  DEFAULT_GALGAME_YEAR_STRING,
  getSearchParamValue,
  toNumberParam
} from '~/utils/galgameFilter'
import { getCurrentSiteYear } from '~/utils/time'

interface Props {
  params: Promise<{ id: string }>
  searchParams?: Promise<{
    page?: string | string[]
    sortField?: SortField | string[]
    sortOrder?: SortOrder | string[]
    selectedType?: string | string[]
    selectedLanguage?: string | string[]
    selectedPlatform?: string | string[]
    yearString?: string | string[]
    monthString?: string | string[]
    minRatingCount?: string | string[]
  }>
}

export const generateMetadata = async ({
  params
}: Props): Promise<Metadata> => {
  const { id } = await params
  const company = await kunGetCompanyByIdActions({ companyId: Number(id) })
  return generateKunMetadataTemplate(company)
}

export default async function Kun({ params, searchParams }: Props) {
  const { id } = await params
  const res = await searchParams
  const companyId = Number(id)
  const sortField =
    (getSearchParamValue(res?.sortField) as SortField | undefined) ||
    DEFAULT_GALGAME_SORT_FIELD
  const sortOrder =
    (getSearchParamValue(res?.sortOrder) as SortOrder | undefined) ||
    DEFAULT_GALGAME_SORT_ORDER
  const currentPage = toNumberParam(getSearchParamValue(res?.page), 1)
  const selectedType =
    getSearchParamValue(res?.selectedType) || DEFAULT_GALGAME_FILTER_VALUE
  const selectedLanguage =
    getSearchParamValue(res?.selectedLanguage) || DEFAULT_GALGAME_FILTER_VALUE
  const selectedPlatform =
    getSearchParamValue(res?.selectedPlatform) || DEFAULT_GALGAME_FILTER_VALUE
  const yearString =
    getSearchParamValue(res?.yearString) || DEFAULT_GALGAME_YEAR_STRING
  const monthString =
    getSearchParamValue(res?.monthString) || DEFAULT_GALGAME_MONTH_STRING
  const minRatingCount =
    sortField === 'rating'
      ? toNumberParam(
          getSearchParamValue(res?.minRatingCount),
          DEFAULT_TAG_COMPANY_MIN_RATING_COUNT
        )
      : 0

  const result = await kunGetCompanyPageDataActions({
    companyId,
    page: currentPage,
    limit: 24,
    selectedType,
    selectedLanguage,
    selectedPlatform,
    sortField,
    sortOrder,
    yearString,
    monthString,
    minRatingCount
  })
  if (typeof result === 'string') {
    return <ErrorComponent error={result} />
  }

  const { company, response } = result

  return (
    <>
      <KunBreadcrumbTitle
        routeKey={`/company/${company.id}`}
        title={company.name}
      />
      <CompanyDetailContainer
        initialCompany={company}
        initialPatches={response.galgames}
        total={response.total}
        filterEndYear={getCurrentSiteYear()}
      />
    </>
  )
}
