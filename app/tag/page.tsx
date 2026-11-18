import { Container } from '~/components/tag/Container'
import { kunMetadata } from './metadata'
import { kunGetActions } from './actions'
import { ErrorComponent } from '~/components/error/ErrorComponent'
import { Suspense } from 'react'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import type { Metadata } from 'next'

export const metadata: Metadata = kunMetadata

export default async function Kun() {
  const payload = await verifyHeaderCookie()
  if (!payload) {
    return (
      <Suspense>
        <Container initialTags={[]} initialTotal={0} />
      </Suspense>
    )
  }

  const response = await kunGetActions({
    page: 1,
    limit: 100
  })
  if (typeof response === 'string') {
    return <ErrorComponent error={response} />
  }

  return (
    <Suspense>
      <Container
        initialTags={response.tags}
        initialTotal={response.total}
        uid={payload.uid}
      />
    </Suspense>
  )
}
