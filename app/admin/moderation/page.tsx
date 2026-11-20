import { Suspense } from 'react'
import { Moderation } from '~/components/admin/moderation/Container'
import { kunMetadata } from './metadata'
import { kunGetModerationTasksActions } from './actions'
import { ErrorComponent } from '~/components/error/ErrorComponent'
import type { Metadata } from 'next'

export const revalidate = 0

export const metadata: Metadata = kunMetadata

export default async function Kun() {
  const response = await kunGetModerationTasksActions({
    page: 1,
    limit: 30,
    status: 'all',
    failureKind: 'all'
  })
  if (typeof response === 'string') {
    return <ErrorComponent error={response} />
  }

  return (
    <Suspense>
      <Moderation initialTasks={response.tasks} initialTotal={response.total} />
    </Suspense>
  )
}
