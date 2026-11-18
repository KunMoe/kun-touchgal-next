import { redirect } from 'next/navigation'
import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { can } from '~/constants/permission'

export default async function Kun() {
  const payload = await verifyHeaderCookie()

  if (!payload) {
    redirect(`/login?from=${encodeURIComponent('/edit')}`)
  }

  if (can(payload, 'galgame.create')) {
    redirect('/edit/create')
  }

  redirect('/')
}
