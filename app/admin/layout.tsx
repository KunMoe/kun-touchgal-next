import { Sidebar } from '~/components/admin/Sidebar'
import { kunMetadata } from './metadata'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { redirect } from 'next/navigation'
import { can } from '~/constants/permission'
import type { Metadata } from 'next'

export const metadata: Metadata = kunMetadata

interface Props {
  children: React.ReactNode
}

export default async function Kun({ children }: Props) {
  const payload = await verifyHeaderCookie()
  if (!can(payload, 'admin.access')) {
    redirect('/')
  }

  return (
    <div className="container flex mx-auto my-4">
      <Sidebar />
      <div className="flex w-full min-w-0 overflow-y-auto">
        <div className="w-full min-w-0 p-4">{children}</div>
      </div>
    </div>
  )
}
