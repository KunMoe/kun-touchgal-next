import { cookies } from 'next/headers'
import { kunRoute } from '~/app/api/utils/kunRoute'
import { deleteKunTokenSession } from '~/server/auth/session'

export const POST = kunRoute.post({
  auth: 'user',
  handler: async ({ actor: payload }) => {
    await deleteKunTokenSession(payload.uid, payload.jti)
    const cookie = await cookies()
    cookie.delete('kun-galgame-patch-moe-token')

    return { message: '退出登录成功' }
  }
})
