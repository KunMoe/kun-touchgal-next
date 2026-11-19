// 安全戳 (user.security_stamp) 的读法与比较。戳由 securityEvents.ts 与凭据写在同一条语句里;
// 站点令牌带签发时读到的戳 (cs, 毫秒), 解析时必须与库里的值相等; OIDC 令牌没法带自定义版本,
// 签发得比戳早 (秒) 就失效。库里的 null 与不带 cs 的存量令牌都按 0 处理, 上线不会把人踢下线

// 上线后先以影子模式跑: 不一致只记一行日志、照常放行。看过 24 小时日志确认站点与 2FA
// 两类不一致为 0 之后, 改成 'enforce' 单独发布 (OIDC 一类在改密之后出现是预期的)
export const KUN_SECURITY_STAMP_MODE = 'shadow' as 'shadow' | 'enforce'

export const stampValueOf = (stamp: Date | null | undefined) =>
  stamp ? stamp.getTime() : 0

export const tokenStampOf = (payload: { cs?: unknown }) =>
  typeof payload.cs === 'number' && Number.isFinite(payload.cs) ? payload.cs : 0

export type KunStampMismatchSource = 'site' | 'two-factor' | 'oidc'

// 记一行可 grep 的日志 (pm2 logs | grep kun-security-stamp), 返回是否应当拒绝
export const rejectOnStampMismatch = (
  source: KunStampMismatchSource,
  detail: Record<string, string | number | undefined>
) => {
  // eslint-disable-next-line no-console
  console.warn(
    `[kun-security-stamp] ${JSON.stringify({ mode: KUN_SECURITY_STAMP_MODE, source, ...detail })}`
  )
  return KUN_SECURITY_STAMP_MODE === 'enforce'
}
