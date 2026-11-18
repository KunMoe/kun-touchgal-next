import 'server-only'

import { getRedirectConfig } from '~/app/api/admin/setting/redirect/getRedirectConfig'
import { getDisableRegisterStatus } from '~/app/api/admin/setting/register/service'
import { getModerationSetting } from '~/app/api/admin/setting/moderation/service'
import { verifySuperAdmin } from '~/utils/actions/parseSuperAdminAction'

export const kunGetRedirectConfigActions = async () => {
  const error = await verifySuperAdmin()
  if (error) {
    return error
  }

  const response = await getRedirectConfig()
  return response
}

export const kunGetDisableRegisterStatusActions = async () => {
  const error = await verifySuperAdmin()
  if (error) {
    return error
  }

  const response = await getDisableRegisterStatus()
  return response
}

export const kunGetModerationSettingActions = async () => {
  const error = await verifySuperAdmin()
  if (error) {
    return error
  }

  const response = await getModerationSetting()
  return response
}
