import 'server-only'

import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { getApplyStatus } from '~/app/api/apply/status/service'

export const kunGetActions = async () => {
  const payload = await verifyHeaderCookie()

  const response = await getApplyStatus(payload?.uid ?? 0)
  return response
}
