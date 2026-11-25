import { acquireKvLock, releaseKvLock, renewKvLock } from '~/lib/redis'

// 作业租约: Redis 里一把带 TTL 的锁 (SET NX), 持有期间每 TTL/3 心跳续一次, 结束时按 token 释放。
// 续租时锁键已经不在或换了主人, 或连续两次续不上 (Redis 不可达), 就当租约已丢: 中止
// lease.signal 并记一条 error, 持有者在下一个检查点停下。所以 TTL 与作业耗时无关, 只决定进程
// 崩溃或被杀之后多久别的进程能接手; 调用方不用再证明「TTL 大于最坏耗时」。
// 没有 fencing: 从锁键丢失到心跳发现最多 TTL/3, 其间可能有两个持有者, 各作业的正确性不能只靠它
// (搜索出箱靠 seq 与对账收敛, 审核靠 picked_at 认领)。接口不暴露 Redis, 需要时可以换成 PG 行租约。
// 心跳与进度脱钩之后, 一个永不返回的持有者 (卡在没有上界的调用上, 例如连接被黑洞掉的 PG 查询)
// 会永远占着锁。所以另有停滞看门狗: 持有者每做完一个工作单元调一次 lease.progress(), 超过
// stallMs 没有进展就停止续租、立即释放、中止 signal 并记一条 error, 别的进程得以接手。不调
// progress 的持有者从拿到锁算起, stallMs 就是它能持有的最长时间

export const DEFAULT_LEASE_TTL_SECONDS = 60
// 默认的停滞上限: 远大于任何一个工作单元 (出箱的一行、计数的一批、审核池的一圈循环都在一分钟
// 以内), 也大于不报进度的作业 (浏览量落库、群发的一拍) 的总耗时
export const DEFAULT_LEASE_STALL_MS = 10 * 60 * 1000
// 连续这么多次续租出错 (不是「续租时发现锁已不是自己的」) 就当租约已丢: 两次即 2/3 个 TTL,
// 在锁键自然过期之前停下
const LEASE_RENEW_ERROR_LIMIT = 2
const LOCK_ACQUIRE_MAX_ATTEMPTS = 3
const LOCK_ACQUIRE_RETRY_DELAY_MS = 500
const LOCK_WAIT_INTERVAL_MS = 2000

export class LeaseLostError extends Error {
  constructor(job: string, reason: string) {
    super(`${job} 的租约已丢失: ${reason}`)
    this.name = 'LeaseLostError'
  }
}

export interface JobLease {
  // 租约丢失 (含停滞) 时中止; 传入的 signal (调用方要求停下, 如作业运行时关停) 中止时同样中止
  signal: AbortSignal
  // 做完一个工作单元: 停滞看门狗从此刻重新计时
  progress: () => void
}

interface LockSpec {
  // 日志里的作业名
  name: string
  key: string
  ttlSeconds: number
  // 锁被别人占着时最多等这么久 (每 2 秒试一次); 默认不等
  waitMs?: number
  // 中止时不再等锁
  signal?: AbortSignal
}

const describeError = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)

// 睡 ms, signal 中止时提前醒
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const wake = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', wake)
      resolve()
    }, ms)
    signal?.addEventListener('abort', wake, { once: true })
  })

// 抢锁: Redis 出错最多试 3 次, 锁被占着的等待不占这 3 次。抢不到 (被占着且等不到, 或 Redis
// 一直出错) 返回 null
const acquireLock = async ({
  name,
  key,
  ttlSeconds,
  waitMs = 0,
  signal
}: LockSpec) => {
  const deadline = Date.now() + waitMs
  let lastError: unknown = null

  for (let attempt = 1; attempt <= LOCK_ACQUIRE_MAX_ATTEMPTS;) {
    if (signal?.aborted) {
      return null
    }
    try {
      const token = await acquireKvLock(key, ttlSeconds)
      if (token || Date.now() >= deadline) {
        return token
      }
      await sleep(LOCK_WAIT_INTERVAL_MS, signal)
    } catch (error) {
      lastError = error
      if (attempt < LOCK_ACQUIRE_MAX_ATTEMPTS) {
        await sleep(LOCK_ACQUIRE_RETRY_DELAY_MS, signal)
      }
      attempt++
    }
  }

  // eslint-disable-next-line no-console
  console.error(`[kun-jobs] ${name} 抢锁失败 (Redis 连续出错):`, lastError)
  return null
}

// 每个时间槽只执行一次 (跨进程): SET NX 一个标记键且不释放, 它活着的 ttlSeconds 之内同一个槽
// 不会再执行。已有标记 (别的进程已经执行过这个槽) 或 Redis 一直出错时返回 false
export const claimJobSlot = async (
  name: string,
  slot: { key: string; ttlSeconds: number }
) => (await acquireLock({ name, ...slot })) !== null

// 持租约执行 fn。抢不到 (锁被占着且 waitMs 内等不到、Redis 一直出错、spec.signal 已中止) 返回
// { ran: false }, fn 不执行
export const withJobLease = async <T>(
  spec: Omit<LockSpec, 'ttlSeconds'> & {
    ttlSeconds?: number
    stallMs?: number
  },
  fn: (lease: JobLease) => Promise<T>
): Promise<{ ran: false } | { ran: true; value: T }> => {
  const ttlSeconds = spec.ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS
  const stallMs = spec.stallMs ?? DEFAULT_LEASE_STALL_MS
  const token = await acquireLock({ ...spec, ttlSeconds })
  if (!token) {
    return { ran: false }
  }
  let lastProgressAt = Date.now()

  const lost = new AbortController()
  const signal = spec.signal
    ? AbortSignal.any([spec.signal, lost.signal])
    : lost.signal
  const loseLease = (reason: string) => {
    const error = new LeaseLostError(spec.name, reason)
    // eslint-disable-next-line no-console
    console.error(`[kun-jobs] ${error.message}`)
    lost.abort(error)
  }

  let finished = false
  let renewErrors = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const scheduleHeartbeat = () => {
    timer = setTimeout(() => void heartbeat(), (ttlSeconds * 1000) / 3)
    // 心跳不该是进程不退出的理由 (命令行脚本里也会用到租约)
    timer.unref?.()
  }
  const heartbeat = async () => {
    if (Date.now() - lastProgressAt >= stallMs) {
      // 不再续租并立即释放: 持有者卡住了, 锁不该跟着它一起卡住
      loseLease(
        `${Math.round((Date.now() - lastProgressAt) / 1000)} 秒没有进展, 停止续租并释放`
      )
      void releaseKvLock(spec.key, token).catch(() => undefined)
      return
    }
    let lostReason: string | null = null
    try {
      const held = await renewKvLock(spec.key, token, ttlSeconds)
      renewErrors = 0
      if (!held) {
        lostReason = '续租时锁键已不存在或已换了持有者'
      }
    } catch (error) {
      renewErrors++
      if (renewErrors >= LEASE_RENEW_ERROR_LIMIT) {
        lostReason = `连续 ${renewErrors} 次续租出错, ${describeError(error)}`
      }
    }
    // fn 在这次续租途中结束 (锁已释放): 结果不再有意义
    if (finished) {
      return
    }
    if (lostReason) {
      loseLease(lostReason)
      return
    }
    scheduleHeartbeat()
  }

  scheduleHeartbeat()
  try {
    return {
      ran: true,
      value: await fn({
        signal,
        progress: () => {
          lastProgressAt = Date.now()
        }
      })
    }
  } finally {
    finished = true
    clearTimeout(timer)
    try {
      await releaseKvLock(spec.key, token)
    } catch (error) {
      // 释放不掉也只是让别的进程多等一个 TTL
      // eslint-disable-next-line no-console
      console.error(`[kun-jobs] ${spec.name} 释放锁失败:`, error)
    }
  }
}
