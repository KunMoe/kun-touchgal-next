import { KunStats } from '~/components/admin/stats/KunStats'
import { kunMetadata } from './metadata'
import type { Metadata } from 'next'

export const metadata: Metadata = kunMetadata

export default async function Kun() {
  return <KunStats />
}
