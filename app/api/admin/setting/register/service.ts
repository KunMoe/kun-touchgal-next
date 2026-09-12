import { getKv } from '~/lib/redis'
import { KUN_PATCH_DISABLE_REGISTER_KEY } from '~/config/redis'

export const getDisableRegisterStatus = async () => {
  const isDisableKunPatchRegister = await getKv(KUN_PATCH_DISABLE_REGISTER_KEY)
  return {
    disableRegister: !!isDisableKunPatchRegister
  }
}
