import { kunRoute } from '~/app/api/utils/kunRoute'

export const POST = kunRoute.post({
  auth: 'public',
  handler: () => '该接口已停用，请使用对应业务接口'
})
