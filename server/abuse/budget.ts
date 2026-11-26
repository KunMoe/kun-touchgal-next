import { can } from '~/constants/permission'
import { kunLog } from '~/lib/log.server'
import { reserveWindows } from './windowCounter'
import { KUN_ABUSE_POLICIES } from './policies'
import type { KunSubject } from '~/constants/role'
import type {
  KunAbusePolicy,
  KunAbusePolicyName,
  KunAbuseWindow
} from './policies'
import type { KunCounterGroup } from './windowCounter'

// 写入口的频率预算 (策略表在 policies.ts)。一次请求的几条策略在同一次 EVAL 里原子判定:
// 任何一条 enforce 的窗口装不下就整次拒绝、哪条都不计数。
//
// 失败取向是放行: Redis 出错时记一条 warn 照常放行。这是软限制, 而且 Redis 故障时会话校验
// 本身先失效, 放行的实际面很小; 凭据预算是另一回事, 在 server/auth 里 fail-closed

// 游客只能扣全站窗口
export type KunAbuseSubject = KunSubject | 'anonymous'

export interface KunAbuseCharge {
  policy: KunAbusePolicyName
  // 这次占几个额度, 默认 1 (提及按收件人数)
  cost?: number
}

export interface KunAbuseDenial {
  policy: KunAbusePolicyName
  per: KunAbuseWindow['per']
  retryAfterSec: number
}

// 表里是字面量类型 (as const); 这里按声明的形状读, mode 等字段才是联合类型
const POLICIES: Readonly<Record<KunAbusePolicyName, KunAbusePolicy>> =
  KUN_ABUSE_POLICIES

// 观察期的统计按 UTC 日期分桶, 留 8 天: 观察一周后还能读到第一天
const STATS_TTL_SECONDS = 8 * 24 * 60 * 60

const windowKey = (
  policy: KunAbusePolicyName,
  window: KunAbuseWindow,
  subject: KunAbuseSubject
) => {
  if (window.per === 'global') {
    return `abuse:${policy}:global:all:${window.windowSeconds}`
  }
  if (subject === 'anonymous') {
    // 写错了表或入口: 游客没有 uid 可计, 不能悄悄变成不限次数
    throw new Error(
      `abuse policy ${policy} has a per-uid window but the caller is anonymous`
    )
  }
  return `abuse:${policy}:uid:${subject.uid}:${window.windowSeconds}`
}

const isExempt = (policy: KunAbusePolicyName, subject: KunAbuseSubject) => {
  const { exempt } = POLICIES[policy]
  return exempt !== null && subject !== 'anonymous' && can(subject, exempt)
}

// 返回 null 即放行 (含观察期超限、整行被止损键关掉、Redis 出错)
export const reserveAbuseBudget = async (
  charges: readonly KunAbuseCharge[],
  subject: KunAbuseSubject
): Promise<KunAbuseDenial | null> => {
  const counted = charges.filter((charge) => !isExempt(charge.policy, subject))
  if (!counted.length) {
    return null
  }

  const groups: KunCounterGroup[] = counted.map(({ policy, cost }) => {
    const { windows, mode } = POLICIES[policy]
    return {
      windows: windows.map((window) => ({
        key: windowKey(policy, window, subject),
        limit: window.limit,
        windowSeconds: window.windowSeconds
      })),
      cost,
      enforce: mode === 'enforce',
      stats: {
        key: `abuse:stats:${policy}:${new Date().toISOString().slice(0, 10)}`,
        ttlSeconds: STATS_TTL_SECONDS
      },
      overrideKey: `abuse:override:${policy}`
    }
  })

  let reservation: Awaited<ReturnType<typeof reserveWindows>>
  try {
    reservation = await reserveWindows(groups)
  } catch (error) {
    kunLog(
      'abuse.budget_unavailable',
      { policies: counted.map((charge) => charge.policy).join(',') },
      error
    )
    return null
  }

  if (reservation.status !== 'exceeded') {
    return null
  }
  // 窗口下标是各组窗口依次展开后的下标
  const windows = counted.flatMap((charge) => POLICIES[charge.policy].windows)
  return {
    policy: counted[reservation.group].policy,
    per: windows[reservation.window].per,
    retryAfterSec: reservation.retryAfterSec
  }
}

const formatWait = (seconds: number) => {
  if (seconds < 60) {
    return `${seconds} 秒`
  }
  if (seconds < 60 * 60) {
    return `${Math.ceil(seconds / 60)} 分钟`
  }
  return `${Math.ceil(seconds / (60 * 60))} 小时`
}

export const kunAbuseMessage = (denial: KunAbuseDenial) =>
  denial.per === 'global'
    ? `当前使用的人太多, 请 ${formatWait(denial.retryAfterSec)}后再试`
    : `操作过于频繁, 请 ${formatWait(denial.retryAfterSec)}后再试`

// 入口用: 返回 string 即拒绝, 按 T | string 的约定原样回给用户 (200 + 文案)
export const kunAbuseGate = async (
  policies: readonly KunAbusePolicyName[],
  subject: KunAbuseSubject
) => {
  const denial = await reserveAbuseBudget(
    policies.map((policy) => ({ policy })),
    subject
  )
  return denial ? kunAbuseMessage(denial) : null
}
