import { ApplyContainer } from '~/components/apply/Container'
import { redirect } from 'next/navigation'
import { kunMetadata } from './metadata'
import { kunGetActions } from './actions'
import { isCreatorRole } from '~/constants/permission'
import type { Metadata } from 'next'

export const metadata: Metadata = kunMetadata

export default async function Kun() {
  const { count, role } = await kunGetActions()

  if (isCreatorRole(role)) {
    redirect('/apply/success')
  }

  return <ApplyContainer count={count} />
}
