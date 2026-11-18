import 'server-only'

import { verifyHeaderCookie } from '~/utils/actions/verifyHeaderCookie'
import { getFolders } from '~/app/api/user/profile/favorite/folder/get'

export const kunGetActions = async (uid: number) => {
  const payload = await verifyHeaderCookie()
  if (!payload) {
    return '用户登录失效'
  }

  const { folders } = await getFolders({}, uid, payload.uid)
  return { folders, currentUserUid: payload.uid }
}
