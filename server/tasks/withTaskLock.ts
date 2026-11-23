import { acquireKvLock, releaseKvLock, renewKvLock } from '~/lib/redis'

const LOCK_ACQUIRE_MAX_ATTEMPTS = 3
const LOCK_ACQUIRE_RETRY_DELAY_MS = 500
const LOCK_WAIT_INTERVAL_MS = 2000

interface TaskLockOptions {
  key: string
  ttlSeconds: number
  taskName: string
  releaseOnComplete?: boolean
  // 锁被别人占着时最多等这么久 (每 2 秒试一次)；默认不等，抢不到就返回 undefined
  waitMs?: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const acquireTaskLock = async (
  key: string,
  ttlSeconds: number,
  taskName: string,
  waitMs: number
) => {
  const deadline = Date.now() + waitMs
  let lastError: unknown = null

  for (let attempt = 1; attempt <= LOCK_ACQUIRE_MAX_ATTEMPTS;) {
    try {
      const token = await acquireKvLock(key, ttlSeconds)
      if (token || Date.now() >= deadline) {
        return token
      }
      // 锁被占着不算出错，不消耗重试次数
      await sleep(LOCK_WAIT_INTERVAL_MS)
    } catch (error) {
      lastError = error

      if (attempt < LOCK_ACQUIRE_MAX_ATTEMPTS) {
        await sleep(LOCK_ACQUIRE_RETRY_DELAY_MS)
      }
      attempt++
    }
  }

  console.error(`Failed to acquire ${taskName} lock:`, lastError)
  return null
}

export const withTaskLock = async <T>(
  options: TaskLockOptions,
  task: (renew: () => Promise<void>) => Promise<T>
) => {
  const {
    key,
    ttlSeconds,
    taskName,
    releaseOnComplete = true,
    waitMs = 0
  } = options
  const lockToken = await acquireTaskLock(key, ttlSeconds, taskName, waitMs)

  if (!lockToken) {
    return
  }

  // 长任务在处理过程中周期调用以保活租约，避免 TTL 过期被第二个 worker 并发接管
  const renew = async () => {
    try {
      await renewKvLock(key, lockToken, ttlSeconds)
    } catch (error) {
      console.error(`Failed to renew ${taskName} lock:`, error)
    }
  }

  try {
    return await task(renew)
  } finally {
    if (releaseOnComplete) {
      try {
        await releaseKvLock(key, lockToken)
      } catch (error) {
        console.error(`Failed to release ${taskName} lock:`, error)
      }
    }
  }
}
