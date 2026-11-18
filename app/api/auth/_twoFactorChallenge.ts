import { createHash } from 'crypto'
import { getKv, setKvIfAbsent } from '~/lib/redis'
import { reserveAttempt, settleSuccess } from '~/server/auth/attemptBudget'
import type { BudgetDimension, BudgetGuard } from '~/server/auth/attemptBudget'

// 登录第二步的尝试预算。入口面是「已过密码与人机验证、持有一次性 challenge」, 与已登录后的
// 二次验证 (server/auth/budgets.ts) 不共桶。预留与结算走 server/auth/attemptBudget, challenge
// 是它的 guard: 不存在或不属于这个用户就不预留, 结算时连同计数一起删掉, 所以一个 challenge
// 只能换一次会话。键名是存量, 逐字不可改 (上线瞬间仍在进行的登录要认得出自己的计数)

export const TWO_FACTOR_CHALLENGE_TTL_SECONDS = 10 * 60
export const TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS = 5

const TWO_FACTOR_UID_WINDOW_SECONDS = 15 * 60
const TWO_FACTOR_UID_MAX_ATTEMPTS = 10
const TWO_FACTOR_UID_IP_WINDOW_SECONDS = 15 * 60
const TWO_FACTOR_UID_IP_MAX_ATTEMPTS = 5

const getChallengeKey = (jti: string) => `auth:2fa:challenge:${jti}`
const getChallengeAttemptsKey = (jti: string) =>
  `auth:2fa:challenge-attempts:${jti}`
const getUidAttemptsKey = (uid: number) => `auth:2fa:uid-attempts:${uid}`
const getUidIpAttemptsKey = (uid: number, ip: string) =>
  `auth:2fa:uid-ip-attempts:${uid}:${createHash('sha256').update(ip).digest('hex')}`

const REJECTION_REASONS = ['challenge', 'uid', 'uidIp'] as const

// 维度的顺序就是用完时上报的优先级; 取不到 IP 时不设第三个维度
const budgetOf = (
  jti: string,
  uid: number,
  ip: string
): { dims: BudgetDimension[]; guard: BudgetGuard } => ({
  guard: { key: getChallengeKey(jti), expected: String(uid) },
  dims: [
    {
      key: getChallengeAttemptsKey(jti),
      limit: TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS,
      windowSeconds: TWO_FACTOR_CHALLENGE_TTL_SECONDS,
      expiresWithGuard: true
    },
    {
      key: getUidAttemptsKey(uid),
      limit: TWO_FACTOR_UID_MAX_ATTEMPTS,
      windowSeconds: TWO_FACTOR_UID_WINDOW_SECONDS
    },
    ...(ip
      ? [
          {
            key: getUidIpAttemptsKey(uid, ip),
            limit: TWO_FACTOR_UID_IP_MAX_ATTEMPTS,
            windowSeconds: TWO_FACTOR_UID_IP_WINDOW_SECONDS
          }
        ]
      : [])
  ]
})

export type TwoFactorAttemptReservation =
  | { allowed: true; remainingAttempts: number }
  | {
      allowed: false
      reason: 'expired' | 'invalid' | 'challenge' | 'uid' | 'uidIp'
    }

export const createTwoFactorChallenge = async (jti: string, uid: number) => {
  const created = await setKvIfAbsent(
    getChallengeKey(jti),
    String(uid),
    TWO_FACTOR_CHALLENGE_TTL_SECONDS
  )
  if (!created) {
    throw new Error('Failed to create unique 2FA challenge')
  }
}

export const isTwoFactorChallengeActive = async (jti: string, uid: number) =>
  (await getKv(getChallengeKey(jti))) === String(uid)

export const reserveTwoFactorAttempt = async (
  jti: string,
  uid: number,
  ip: string
): Promise<TwoFactorAttemptReservation> => {
  const { dims, guard } = budgetOf(jti, uid, ip)
  const reservation = await reserveAttempt(dims, guard)

  if (reservation.allowed) {
    // 这个 challenge 自己还剩几次
    return { allowed: true, remainingAttempts: reservation.remaining[0] }
  }
  if (reservation.reason === 'exhausted') {
    const { dimension } = reservation
    return {
      allowed: false,
      reason: REJECTION_REASONS[dims.findIndex((dim) => dim.key === dimension)]
    }
  }
  return {
    allowed: false,
    reason: reservation.reason === 'guard-missing' ? 'expired' : 'invalid'
  }
}

export const consumeTwoFactorChallenge = (
  jti: string,
  uid: number,
  ip: string
) => {
  const { dims, guard } = budgetOf(jti, uid, ip)
  return settleSuccess(dims, guard)
}
