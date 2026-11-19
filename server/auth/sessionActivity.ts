import { prisma } from '~/prisma/index'
import { acquireKvLock, setKv } from '~/lib/redis'

// 登录时刻与最近活跃时刻 (user.last_login_time)。登录写一次并占住一小时的活跃标记,
// 之后会话解析按标记节流, 一小时至多写一次库
const USER_LAST_ACTIVE_TTL_SECONDS = 60 * 60

const getUserLastActiveKey = (uid: number) => `session:user:last-active:${uid}`

const markUserLastActive = async (uid: number) => {
  await setKv(
    getUserLastActiveKey(uid),
    '1',
    USER_LAST_ACTIVE_TTL_SECONDS
  ).catch(() => undefined)
}

export const updateUserLastLoginTime = async (uid: number) => {
  await prisma.user.update({
    where: { id: uid },
    data: { last_login_time: { set: Date.now().toString() } }
  })
  await markUserLastActive(uid)
}

export const touchUserLastActiveTime = async (uid: number) => {
  const lockToken = await acquireKvLock(
    getUserLastActiveKey(uid),
    USER_LAST_ACTIVE_TTL_SECONDS
  ).catch(() => null)
  if (!lockToken) {
    return
  }

  await prisma.user
    .update({
      where: { id: uid },
      data: { last_login_time: { set: Date.now().toString() } }
    })
    .catch(() => undefined)
}
