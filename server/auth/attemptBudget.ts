import { clearWindows, reserveWindows } from '~/server/abuse/windowCounter'
import type {
  KunCounterGuard,
  KunCounterWindow
} from '~/server/abuse/windowCounter'

// 凭据类尝试预算 (猜密码、猜 TOTP、猜备份码)。语义固定为「先原子预留, 再校验, 成功后
// 结算」: 净效果是只计失败, 但不会出现「先查、失败再加」那种 N 个并发请求同时通过检查的
// 绕过。各入口的维度与阈值在 budgets.ts。
//
// Redis 异常一律抛出, 由调用方映射成「验证服务暂不可用」(fail-closed)。这不会新增不可用面:
// 会话校验本身就要 Redis。
//
// 计数脚本是 server/abuse/windowCounter.ts 那一份 (一组、始终 enforce、没有统计与止损键);
// 语义由真 Redis 契约测试守护 (server/auth/__tests__/attemptBudget.redis.test.ts), 改脚本前
// 先看 lib/__tests__/redisContract.ts 的运行方式

// 窗口从该维度的第一次尝试起算, 之后的尝试不续期; expiresWithGuard 让计数随 guard 一起过期
// (取 guard 的剩余寿命), guard 没有 TTL 时退回 windowSeconds
export type BudgetDimension = KunCounterWindow

// 预留的前提: 这个键存在且值等于 expected (例如登录第一步发出的一次性 challenge)
export type BudgetGuard = KunCounterGuard

export type AttemptReservation =
  // remaining 与 dims 逐项对应: 本次预留之后各维度还剩几次
  | { allowed: true; remaining: number[] }
  | { allowed: false; reason: 'guard-missing' | 'guard-mismatch' }
  // dimension 是第一个用完的维度的 key (按 dims 的顺序判)
  | { allowed: false; reason: 'exhausted'; dimension: string }

// 任何一个维度用完就整体拒绝且一个都不加; 全部通过才逐个加一
export const reserveAttempt = async (
  dims: readonly BudgetDimension[],
  guard?: BudgetGuard
): Promise<AttemptReservation> => {
  // 没有维度就没有上限: 调用方漏传不能变成可以无限次尝试
  if (!dims.length) {
    throw new Error('attempt budget needs at least one dimension')
  }

  const reservation = await reserveWindows(
    [{ windows: dims, enforce: true }],
    guard
  )
  switch (reservation.status) {
    case 'reserved':
      return { allowed: true, remaining: reservation.remaining }
    case 'exceeded':
      return {
        allowed: false,
        reason: 'exhausted',
        dimension: dims[reservation.window].key
      }
    default:
      return { allowed: false, reason: reservation.status }
  }
}

// 校验通过后调用: 清掉各维度的计数 (此前的失败一笔勾销)。带 guard 时返回 false 表示
// guard 已不在或已被别的请求结算, 调用方不得再发放凭据
export const settleSuccess = (
  dims: readonly BudgetDimension[],
  guard?: BudgetGuard
) => clearWindows(dims, guard)
