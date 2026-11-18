import { evalKvScript } from '~/lib/redis'

// 凭据类尝试预算 (猜密码、猜 TOTP、猜备份码)。语义固定为「先原子预留, 再校验, 成功后
// 结算」: 净效果是只计失败, 但不会出现「先查、失败再加」那种 N 个并发请求同时通过检查的
// 绕过。各入口的维度与阈值在 budgets.ts。
//
// Redis 异常一律抛出, 由调用方映射成「验证服务暂不可用」(fail-closed)。这不会新增不可用面:
// 会话校验本身就要 Redis。
//
// 脚本语义由真 Redis 契约测试守护 (server/auth/__tests__/attemptBudget.redis.test.ts),
// 改脚本前先看 lib/__tests__/redisContract.ts 的运行方式

export interface BudgetDimension {
  key: string
  limit: number
  // 窗口从该维度的第一次尝试起算, 之后的尝试不续期
  windowSeconds: number
  // 计数随 guard 一起过期 (取 guard 的剩余寿命); guard 没有 TTL 时退回 windowSeconds
  expiresWithGuard?: boolean
}

// 预留的前提: 这个键存在且值等于 expected (例如登录第一步发出的一次性 challenge)
export interface BudgetGuard {
  key: string
  expected: string
}

export type AttemptReservation =
  // remaining 与 dims 逐项对应: 本次预留之后各维度还剩几次
  | { allowed: true; remaining: number[] }
  | { allowed: false; reason: 'guard-missing' | 'guard-mismatch' }
  // dimension 是第一个用完的维度的 key (按 dims 的顺序判)
  | { allowed: false; reason: 'exhausted'; dimension: string }

// KEYS = 各维度的计数键, 带 guard 时再加 guard 键
// ARGV = 维度个数, guard 期望值 (无 guard 时为空串), 之后每个维度三项: limit, window, 是否随 guard 过期
// 任何一个维度用完就整体拒绝且一个都不加; 全部通过才逐个加一
const RESERVE_SCRIPT = `
  local n = tonumber(ARGV[1])
  local guardKey = KEYS[n + 1]

  if guardKey then
    local guard = redis.call("get", guardKey)
    if not guard then
      return {0}
    end
    if guard ~= ARGV[2] then
      return {-1}
    end
  end

  for i = 1, n do
    local count = tonumber(redis.call("get", KEYS[i]) or "0")
    if count >= tonumber(ARGV[3 * i]) then
      return {2, i}
    end
  end

  local reply = {1}
  for i = 1, n do
    local count = redis.call("incr", KEYS[i])
    if count == 1 then
      local window = tonumber(ARGV[3 * i + 1])
      if guardKey and ARGV[3 * i + 2] == "1" then
        local guardTtl = redis.call("ttl", guardKey)
        if guardTtl > 0 then
          window = guardTtl
        end
      end
      redis.call("expire", KEYS[i], window)
    end
    reply[i + 1] = tonumber(ARGV[3 * i]) - count
  end
  return reply
`

// KEYS 与 ARGV[1..2] 同上。带 guard 时只有 guard 仍等于期望值才结算, 并把 guard 一并删掉:
// 同一个 guard 只能结算一次
const SETTLE_SCRIPT = `
  local n = tonumber(ARGV[1])
  local guardKey = KEYS[n + 1]

  if guardKey then
    if redis.call("get", guardKey) ~= ARGV[2] then
      return 0
    end
    redis.call("del", guardKey)
  end

  for i = 1, n do
    redis.call("del", KEYS[i])
  end
  return 1
`

const keysOf = (dims: readonly BudgetDimension[], guard?: BudgetGuard) => [
  ...dims.map((dim) => dim.key),
  ...(guard ? [guard.key] : [])
]

export const reserveAttempt = async (
  dims: readonly BudgetDimension[],
  guard?: BudgetGuard
): Promise<AttemptReservation> => {
  // 没有维度就没有上限: 调用方漏传不能变成可以无限次尝试
  if (!dims.length) {
    throw new Error('attempt budget needs at least one dimension')
  }

  const [status, ...rest] = await evalKvScript<number[]>(
    RESERVE_SCRIPT,
    keysOf(dims, guard),
    [
      dims.length,
      guard?.expected ?? '',
      ...dims.flatMap((dim) => [
        dim.limit,
        dim.windowSeconds,
        dim.expiresWithGuard ? 1 : 0
      ])
    ]
  )

  if (status === 1) {
    return { allowed: true, remaining: rest }
  }
  if (status === 2) {
    return {
      allowed: false,
      reason: 'exhausted',
      dimension: dims[rest[0] - 1].key
    }
  }
  return {
    allowed: false,
    reason: status === 0 ? 'guard-missing' : 'guard-mismatch'
  }
}

// 校验通过后调用: 清掉各维度的计数 (此前的失败一笔勾销)。带 guard 时返回 false 表示
// guard 已不在或已被别的请求结算, 调用方不得再发放凭据
export const settleSuccess = async (
  dims: readonly BudgetDimension[],
  guard?: BudgetGuard
) => {
  const settled = await evalKvScript<number>(
    SETTLE_SCRIPT,
    keysOf(dims, guard),
    [dims.length, guard?.expected ?? '']
  )
  return settled === 1
}
