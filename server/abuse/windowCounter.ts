import { evalKvScript } from '~/lib/redis'

// 全仓唯一一份固定窗口计数脚本。凭据的尝试预算 (server/auth/attemptBudget.ts) 与写入口的
// 频率预算 (server/abuse/budget.ts) 都是它的薄封装: 再要计数就复用这里, 不要另写一份。
//
// 一次调用交一组或几组窗口 (频率预算里一组就是一条策略), 在同一次 EVAL 里先全部检查、
// 再全部计数, 所以 N 个并发请求不会同时通过检查:
// - 窗口从第一次计数起算, 之后的计数不续期
// - 任何一个 enforce 组的窗口装不下这组的 cost, 整次拒绝, 哪个窗口都不加
// - 不 enforce 的组 (观察期) 有窗口装不下时照常放行, 但这组的窗口一个都不加: 与它 enforce 之后
//   拒掉这次请求时一样, 这组的计数器才与 enforce 之后走得一模一样, 观察期里记下的「装不下」
//   就是这组改成 enforce 之后会多拒的次数
// - 统计只记这次请求的实际结局: 放行时每组记 total, 装不下的观察组再记 exceeded; 被拒时只记
//   拒绝它的那几组 (enforce 且装不下), 别的组不记 —— 这次请求不论它们怎样都会被拒
// - 组的止损键值为 off 时, 这组既不检查也不计数, 也不记统计
// 脚本只用 GET / INCRBY / EXPIRE / TTL / PTTL / HINCRBY / DEL (生产是 Redis 8.0, 这些都是
// 2.x 就有的命令)。语义由真 Redis 契约测试守护 (__tests__/windowCounter.redis.test.ts,
// 以及 server/auth 与登录 2FA 的两份), 改脚本前先看 lib/__tests__/redisContract.ts

export interface KunCounterWindow {
  key: string
  limit: number
  // 窗口从第一次计数起算, 之后的计数不续期
  windowSeconds: number
  // 计数随 guard 一起过期 (取 guard 的剩余寿命); guard 没有 TTL 或没有 guard 时退回 windowSeconds
  expiresWithGuard?: boolean
}

export interface KunCounterGroup {
  windows: readonly KunCounterWindow[]
  // 这次占几个额度, 默认 1
  cost?: number
  // false 即观察期: 装不下也放行
  enforce: boolean
  // 统计用的 hash: total 与 exceeded, 记法见文件头。ttlSeconds 只在 hash 刚建出来时设
  stats?: { key: string; ttlSeconds: number }
  // 值为 off 时这组既不检查也不计数 (止损开关; 不带 TTL, 不会被 volatile-* 淘汰)
  overrideKey?: string
}

// 计数的前提: 这个键存在且值等于 expected (例如登录第一步发出的一次性 challenge)
export interface KunCounterGuard {
  key: string
  expected: string
}

export type KunCounterReservation =
  // remaining 按各组窗口依次展开后的顺序: 本次之后各窗口还剩多少。观察组装不下时这组都没
  // 计数, 装不下的窗口报负数 (还差多少); 关掉的组的窗口按满额报
  | { status: 'reserved'; remaining: number[] }
  // group / window 是第一个装不下的 enforce 窗口所在的组与它展开后的下标 (都从 0 起);
  // retryAfterSec 取所有装不下的 enforce 窗口里还剩最久的那个: 只报第一个的话, 到点重试
  // 还会被更长的窗口拒掉
  | {
      status: 'exceeded'
      group: number
      window: number
      retryAfterSec: number
    }
  | { status: 'guard-missing' }
  | { status: 'guard-mismatch' }

// KEYS = 各组依次: [统计键] [止损键] 窗口键...; 带 guard 时最后再加 guard 键
// ARGV = 是否带 guard, guard 期望值, 组数; 每组六项: 窗口数, cost, 是否 enforce, 是否有统计键,
// 统计键 TTL, 是否有止损键; 之后每个窗口三项: limit, 窗口秒数, 是否随 guard 过期
// 回复: {1, 各窗口剩余...} 放行; {2, 窗口下标, 组下标, 重试毫秒数} 拒绝 (下标从 1 起;
// 键不在或没有 TTL 时那个窗口按整个窗口算); {0} guard 不在; {-1} guard 的值不对
const RESERVE_SCRIPT = `
  local groupCount = tonumber(ARGV[3])
  local groups = {}
  local windows = {}
  local k = 1
  local w = 4 + 6 * groupCount
  for g = 1, groupCount do
    local h = 4 + 6 * (g - 1)
    local group = {
      cost = tonumber(ARGV[h + 1]),
      enforce = ARGV[h + 2] == "1",
      statsTtl = tonumber(ARGV[h + 4])
    }
    if ARGV[h + 3] == "1" then
      group.stats = KEYS[k]
      k = k + 1
    end
    if ARGV[h + 5] == "1" then
      group.override = KEYS[k]
      k = k + 1
    end
    for i = 1, tonumber(ARGV[h]) do
      windows[#windows + 1] = {
        key = KEYS[k],
        limit = tonumber(ARGV[w]),
        seconds = tonumber(ARGV[w + 1]),
        withGuard = ARGV[w + 2] == "1",
        group = g
      }
      k = k + 1
      w = w + 3
    end
    groups[g] = group
  end

  local guardKey = nil
  if ARGV[1] == "1" then
    guardKey = KEYS[k]
    local guard = redis.call("get", guardKey)
    if not guard then
      return {0}
    end
    if guard ~= ARGV[2] then
      return {-1}
    end
  end

  for _, group in ipairs(groups) do
    group.off = group.override ~= nil and redis.call("get", group.override) == "off"
  end

  local denied = nil
  for i, window in ipairs(windows) do
    local group = groups[window.group]
    if not group.off then
      window.used = tonumber(redis.call("get", window.key) or "0")
      if window.used + group.cost > window.limit then
        window.full = true
        group.full = true
        if group.enforce and not denied then
          denied = i
        end
      end
    end
  end

  local function record(group)
    redis.call("hincrby", group.stats, "total", 1)
    if group.full then
      redis.call("hincrby", group.stats, "exceeded", 1)
    end
    if redis.call("ttl", group.stats) < 0 then
      redis.call("expire", group.stats, group.statsTtl)
    end
  end

  if denied then
    local retryMs = 0
    for _, window in ipairs(windows) do
      local group = groups[window.group]
      if window.full and group.enforce then
        local pttl = redis.call("pttl", window.key)
        if pttl <= 0 then
          pttl = window.seconds * 1000
        end
        if pttl > retryMs then
          retryMs = pttl
        end
      end
    end
    for _, group in ipairs(groups) do
      if group.stats and group.full and group.enforce then
        record(group)
      end
    end
    return {2, denied, windows[denied].group, retryMs}
  end

  for _, group in ipairs(groups) do
    if group.stats and not group.off then
      record(group)
    end
  end

  local reply = {1}
  for i, window in ipairs(windows) do
    local group = groups[window.group]
    if group.off then
      reply[i + 1] = window.limit
    elseif window.full then
      reply[i + 1] = window.limit - window.used - group.cost
    elseif group.full then
      reply[i + 1] = window.limit - window.used
    else
      local count = redis.call("incrby", window.key, group.cost)
      if count == group.cost then
        local seconds = window.seconds
        if guardKey and window.withGuard then
          local guardTtl = redis.call("ttl", guardKey)
          if guardTtl > 0 then
            seconds = guardTtl
          end
        end
        redis.call("expire", window.key, seconds)
      end
      reply[i + 1] = window.limit - count
    end
  end
  return reply
`

// KEYS = 各窗口的键, 带 guard 时再加 guard 键; ARGV = 窗口数, guard 期望值 (无 guard 时为空串)。
// 带 guard 时只有 guard 仍等于期望值才清, 并把 guard 一并删掉: 同一个 guard 只能清一次
const CLEAR_SCRIPT = `
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

const isPositiveInteger = (value: number) =>
  Number.isSafeInteger(value) && value > 0

export const reserveWindows = async (
  groups: readonly KunCounterGroup[],
  guard?: KunCounterGuard
): Promise<KunCounterReservation> => {
  const windows = groups.flatMap((group) => group.windows)
  // 没有窗口就没有上限: 调用方漏传不能变成不限次数
  if (!windows.length) {
    throw new Error('window counter needs at least one window')
  }
  // cost 是调用时算出来的 (提及按收件人数): 负数会让 INCRBY 退还额度
  if (groups.some((group) => !isPositiveInteger(group.cost ?? 1))) {
    throw new Error('window counter cost must be a positive integer')
  }

  const keys = [
    ...groups.flatMap((group) => [
      ...(group.stats ? [group.stats.key] : []),
      ...(group.overrideKey ? [group.overrideKey] : []),
      ...group.windows.map((window) => window.key)
    ]),
    ...(guard ? [guard.key] : [])
  ]
  const args = [
    guard ? 1 : 0,
    guard?.expected ?? '',
    groups.length,
    ...groups.flatMap((group) => [
      group.windows.length,
      group.cost ?? 1,
      group.enforce ? 1 : 0,
      group.stats ? 1 : 0,
      group.stats?.ttlSeconds ?? 0,
      group.overrideKey ? 1 : 0
    ]),
    ...windows.flatMap((window) => [
      window.limit,
      window.windowSeconds,
      window.expiresWithGuard ? 1 : 0
    ])
  ]

  const [status, ...rest] = await evalKvScript<number[]>(
    RESERVE_SCRIPT,
    keys,
    args
  )

  if (status === 1) {
    return { status: 'reserved', remaining: rest }
  }
  if (status === 2) {
    const [window, group, retryMs] = rest
    return {
      status: 'exceeded',
      group: group - 1,
      window: window - 1,
      retryAfterSec: Math.ceil(retryMs / 1000)
    }
  }
  return { status: status === 0 ? 'guard-missing' : 'guard-mismatch' }
}

// 清掉这些窗口的计数。带 guard 时返回 false 表示 guard 已不在或已被别的请求清过
export const clearWindows = async (
  windows: readonly Pick<KunCounterWindow, 'key'>[],
  guard?: KunCounterGuard
) => {
  const cleared = await evalKvScript<number>(
    CLEAR_SCRIPT,
    [...windows.map((window) => window.key), ...(guard ? [guard.key] : [])],
    [windows.length, guard?.expected ?? '']
  )
  return cleared === 1
}
