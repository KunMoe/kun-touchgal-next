import { CardContainer } from '~/components/resource/Container'
import { kunMetadata } from './metadata'
import { Suspense } from 'react'
import { kunGetActions } from './actions'
import { getSearchParamValue, toNumberParam } from '~/utils/galgameFilter'
import { ErrorComponent } from '~/components/error/ErrorComponent'
import type { Metadata } from 'next'

export const metadata: Metadata = kunMetadata

interface Props {
  searchParams?: Promise<{ page?: string | string[] }>
}

export default async function Kun({ searchParams }: Props) {
  const res = await searchParams
  const currentPage = toNumberParam(getSearchParamValue(res?.page), 1)

  const response = await kunGetActions({
    sortField: 'created',
    sortOrder: 'desc',
    page: currentPage,
    limit: 50
  })
  if (typeof response === 'string') {
    return <ErrorComponent error={response} />
  }

  return (
    <Suspense>
      <CardContainer
        initialResources={response.resources}
        initialTotal={response.total}
      />
    </Suspense>
  )
}
