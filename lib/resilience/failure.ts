// 外部依赖调用失败的协议层词表: 只回答「这次失败说明了什么范围的问题」, 不 import 任何
// 客户端, 也不决定失败之后怎么办 (重试、熔断、记账由各调用方按自己的语义定)。
//
// - transient      依赖此刻不可用 (5xx、超时、断流、连不上), 过一会儿多半会好
// - rate_limited   依赖在限流 (429), 等它给的时间
// - misconfigured  凭据或地址不对 (401/403/404), 不改配置永远不会好
// - request        依赖答复了, 是这一次请求自己的问题 (400/413/422、输出不合约定)
//
// 前三类对同一依赖的所有请求同时成立, 只有 request 该由发起它的那一条承担

export type FailureScope =
  'transient' | 'rate_limited' | 'misconfigured' | 'request'

export type KunDependency = 'moderation_ai' | 's3'

export class DependencyFailure extends Error {
  readonly dependency: KunDependency
  readonly scope: FailureScope
  // 依赖回了 HTTP 应答时的状态码; 没拿到应答 (传输层失败、本地判定) 为 null
  readonly status: number | null
  readonly retryAfterMs: number | null

  constructor(input: {
    dependency: KunDependency
    scope: FailureScope
    message: string
    status?: number | null
    retryAfterMs?: number | null
    cause?: unknown
  }) {
    super(
      input.message,
      input.cause === undefined ? undefined : { cause: input.cause }
    )
    this.name = 'DependencyFailure'
    this.dependency = input.dependency
    this.scope = input.scope
    this.status = input.status ?? null
    this.retryAfterMs = input.retryAfterMs ?? null
  }
}

// 认不出的状态码归 request: 算在这一条请求头上是最保守的归属, 不会让一条有问题的
// 请求被当成「依赖不可用」而免于计数
export const classifyHttpStatus = (status: number): FailureScope => {
  if (status === 401 || status === 403 || status === 404) {
    return 'misconfigured'
  }
  if (status === 429) {
    return 'rate_limited'
  }
  if (status === 408 || status === 425 || status >= 500) {
    return 'transient'
  }
  return 'request'
}

const HTTP_DATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/

// Retry-After 的两种形式 (RFC 9110 §10.2.3): 秒数, 或 HTTP-date。日期只认 IMF-fixdate,
// 其余写法 Date.parse 会各自猜出一个时刻, 一律当作没给
export const parseRetryAfterMs = (
  value: string | null,
  nowMs: number
): number | null => {
  const text = value?.trim()
  if (!text) {
    return null
  }
  if (/^\d+$/.test(text)) {
    return Number(text) * 1000
  }
  if (!HTTP_DATE.test(text)) {
    return null
  }
  const at = Date.parse(text)
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs)
}

// 连接阶段与读流阶段的系统错误码; fetch (undici) 把它挂在 TypeError 的 cause 上,
// AWS SDK 的 node handler 直接挂在错误自身
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET'
])

const codeOf = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  'code' in value &&
  typeof value.code === 'string'
    ? value.code
    : null

const networkCodeOf = (error: Error) => {
  const code = codeOf(error) ?? codeOf(error.cause)
  return code !== null && NETWORK_ERROR_CODES.has(code) ? code : null
}

// 没拿到 HTTP 应答的失败: 超时 / 中止 (AbortSignal.timeout 抛 DOMException, AWS SDK 抛
// 同名的普通 Error) 与上面的网络错误码是依赖不可用; 其余 (含不带 cause 的 TypeError,
// 那是代码自己的错) 返回 null, 由调用方当成未知错误
export const classifyTransportError = (error: unknown): FailureScope | null => {
  if (!(error instanceof Error)) {
    return null
  }
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return 'transient'
  }
  return networkCodeOf(error) === null ? null : 'transient'
}

const awsStatusOf = (error: unknown) => {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) {
    return undefined
  }
  const metadata = error.$metadata
  const status =
    typeof metadata === 'object' &&
    metadata !== null &&
    'httpStatusCode' in metadata
      ? metadata.httpStatusCode
      : null
  return typeof status === 'number' ? status : null
}

// AWS SDK v3 的服务异常: 按结构 ($metadata.httpStatusCode、$fault) 判断, 不 import SDK。
// 404 在这里是「请求指名的那个对象不存在」, 不是凭据或地址错了, 归 request
export const classifyAwsSdkError = (error: unknown): FailureScope | null => {
  const status = awsStatusOf(error)
  if (status === undefined) {
    return null
  }
  if (status !== null) {
    return status === 404 ? 'request' : classifyHttpStatus(status)
  }
  const fault =
    typeof error === 'object' && error !== null && '$fault' in error
      ? error.$fault
      : null
  if (fault === 'server') {
    return 'transient'
  }
  return fault === 'client' ? 'request' : null
}

// 在调用依赖的边界上把抓到的错误翻成 DependencyFailure。认不出来的原样返回: 它不是
// 依赖的问题, 调用方照旧往外抛
export const toDependencyFailure = (
  dependency: KunDependency,
  error: unknown
): unknown => {
  if (error instanceof DependencyFailure) {
    return error
  }
  const scope = classifyAwsSdkError(error) ?? classifyTransportError(error)
  if (scope === null || !(error instanceof Error)) {
    return error
  }
  const code = networkCodeOf(error)
  return new DependencyFailure({
    dependency,
    scope,
    message: code === null ? error.message : `${error.message} (${code})`,
    status: awsStatusOf(error) ?? null,
    cause: error
  })
}
