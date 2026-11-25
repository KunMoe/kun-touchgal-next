import { prisma } from '~/prisma/index'
import { delKv, getKv, setKv } from '~/lib/redis'
import { USER_PENDING_RESOURCE_CACHE_DURATION } from '~/config/cache'
import { RESOURCE_STATUS } from '~/constants/contentStatus'

// hasPendingResource 几乎恒为 false, 却在每个已登录非管理员的首页/资源列表请求里
// 查一次 DB, 把纯缓存命中变成"命中 + 1 次 DB 往返 + 1 次 pool 借用". 读穿 Redis
// (短 TTL) 消除绝大多数此类查询; 资源进出 status 2/3 时由写路径失效该键
const getPendingResourceCacheKey = (uid: number) =>
  `user:has-pending-resource:${uid}`

const logPendingResourceCacheError = (message: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(message, error)
}

// 作者是否有待审核 (status 2/3) 资源: 读穿 Redis, 未命中回落 DB count 并回填
export const hasPendingResource = async (uid: number) => {
  const cacheKey = getPendingResourceCacheKey(uid)

  try {
    const cached = await getKv(cacheKey)
    if (cached !== null) {
      return cached === '1'
    }
  } catch (error) {
    logPendingResourceCacheError(
      'Failed to read pending resource cache:',
      error
    )
  }

  const pendingResourceCount = await prisma.patch_resource.count({
    where: {
      user_id: uid,
      status: {
        in: [RESOURCE_STATUS.awaitingApproval, RESOURCE_STATUS.pending]
      }
    }
  })
  const hasPending = pendingResourceCount > 0

  try {
    await setKv(
      cacheKey,
      hasPending ? '1' : '0',
      USER_PENDING_RESOURCE_CACHE_DURATION
    )
  } catch (error) {
    logPendingResourceCacheError(
      'Failed to write pending resource cache:',
      error
    )
  }

  return hasPending
}

// 资源进出 status 2/3 后由写路径调用, 让下次读穿重算; Redis 故障不影响主流程
export const invalidateUserPendingResourceCache = async (uid: number) => {
  try {
    await delKv(getPendingResourceCacheKey(uid))
  } catch (error) {
    logPendingResourceCacheError(
      'Failed to invalidate pending resource cache:',
      error
    )
  }
}
