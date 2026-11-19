import { kunRoute } from '~/app/api/utils/kunRoute'
import { adminUpdateDisableRegisterSchema } from '~/validations/admin'
import { delKv, setKv } from '~/lib/redis'
import { KUN_PATCH_DISABLE_REGISTER_KEY } from '~/config/redis'
import { getDisableRegisterStatus } from './service'

export const GET = kunRoute.get({
  auth: 'user',
  capability: 'admin.access',
  handler: () => getDisableRegisterStatus()
})

export const PUT = kunRoute.put({
  auth: 'user',
  capability: 'admin.access',
  input: adminUpdateDisableRegisterSchema,
  handler: async ({ input }) => {
    if (input.disableRegister) {
      await setKv(KUN_PATCH_DISABLE_REGISTER_KEY, 'true')
    } else {
      await delKv(KUN_PATCH_DISABLE_REGISTER_KEY)
    }

    return {}
  }
})
