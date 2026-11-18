import 'server-only'

import { getOidcClients } from '~/app/api/admin/oidc/service'
import { verifySuperAdmin } from '~/utils/actions/parseSuperAdminAction'

export const kunGetOidcClients = async () => {
  const error = await verifySuperAdmin()
  if (error) {
    return error
  }

  return getOidcClients()
}
