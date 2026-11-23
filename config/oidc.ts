// OIDC Provider 常量。issuer 必须带 /oidc 前缀，dev 无 OIDC_ISSUER 时回退到本地地址。
// provider 输出的全部绝对地址与 cookie 的 Secure 只由 issuer 决定（lib/oidc/webToNode.ts），
// 不跟请求的 Host 走：生产上它必须等于依赖方实际访问的源；换端口另起 dev 时要同时设 OIDC_ISSUER。
export const OIDC_ISSUER =
  process.env.OIDC_ISSUER || 'http://127.0.0.1:3000/oidc'

// provider 挂载路径前缀，用于 webToNode 适配时剥离，使 provider 内部按相对路径路由。
export const OIDC_MOUNT_PATH = '/oidc'

// scope -> 可返回的 claims 映射，仅覆盖本站 user 表拥有的字段。
export const OIDC_CLAIMS: Record<string, string[]> = {
  openid: ['sub'],
  profile: ['name', 'picture', 'profile'],
  email: ['email', 'email_verified']
}

// 各类 OIDC 对象的 TTL（秒），同时用于 provider ttl 与 Redis Adapter 过期。
export const OIDC_TTL = {
  AccessToken: 60 * 60,
  AuthorizationCode: 10 * 60,
  IdToken: 60 * 60,
  RefreshToken: 14 * 24 * 60 * 60,
  Interaction: 60 * 60,
  Session: 14 * 24 * 60 * 60,
  Grant: 14 * 24 * 60 * 60
}
