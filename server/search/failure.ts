import { isMeiliEnabled } from '~/lib/meilisearch'
import { classifyHttpStatus, type FailureScope } from '~/lib/resilience/failure'

// 这些错误码说的是「这一次请求的参数非法」, 只可能来自请求内容
const REQUEST_ERROR_CODES = new Set([
  'invalid_search_page',
  'invalid_search_hits_per_page',
  'invalid_search_limit',
  'invalid_search_offset',
  'invalid_search_q',
  // 请求体不是合法 JSON。请求体由 SDK 用 JSON.stringify 组装, 只有关键词或筛选值里
  // 带孤立代理 (lone surrogate) 时才会出现, 不会是部署漂移
  'malformed_payload'
])

interface MeiliErrorShape {
  name?: unknown
  message?: unknown
  response?: { status?: unknown } | null
  cause?: { code?: unknown; name?: unknown } | null
}

const shapeOf = (error: unknown): MeiliErrorShape =>
  typeof error === 'object' && error !== null ? error : {}

// 一次索引查询的失败说明了什么范围的问题 (词表见 lib/resilience/failure.ts):
// transient / rate_limited  Meilisearch 此刻不可用: 连不上、超时、5xx、429
// misconfigured             索引与代码不一致: 索引不存在, 排序 / 过滤 / 检索字段没注册
//                           (漏跑 pnpm search:init), 密钥不对
// request                   这一次请求的参数被拒, 换一个引擎也不该受理
// 不是 Meilisearch 抛出的错误返回 null。
// 按 name 与错误码判别, 不用 instanceof: SDK 被重复加载成两份时 instanceof 恒假。
// 4xx 不能只看状态码: 「页码非法」与「排序字段没注册」都是 400, 要看 code
export const classifyMeiliFailure = (error: unknown): FailureScope | null => {
  const { name, response, cause } = shapeOf(error)

  // fetch 自己失败 (拒连、DNS、超时) 由 SDK 包成 MeilisearchRequestError
  if (
    name === 'MeilisearchRequestError' ||
    name === 'MeilisearchRequestTimeOutError'
  ) {
    return 'transient'
  }
  if (name !== 'MeilisearchApiError') {
    return null
  }

  const byStatus =
    typeof response?.status === 'number'
      ? classifyHttpStatus(response.status)
      : 'misconfigured'
  if (byStatus === 'transient' || byStatus === 'rate_limited') {
    return byStatus
  }
  return typeof cause?.code === 'string' && REQUEST_ERROR_CODES.has(cause.code)
    ? 'request'
    : 'misconfigured'
}

// Meilisearch 判定这次请求的参数非法。不换引擎: 调用方把它翻成业务错误
export class MeiliBadRequestError extends Error {
  constructor(cause: unknown) {
    super('Meilisearch 拒绝了这次请求的参数', { cause })
    this.name = 'MeiliBadRequestError'
  }
}

// 有应答时 cause 是 Meilisearch 的错误体; 没拿到应答时 cause 是 fetch 抛的原始错误
// (TimeoutError / TypeError)
const summarize = (error: unknown) => {
  const { name, message, response, cause } = shapeOf(error)
  return response
    ? { name, status: response.status, code: cause?.code, message }
    : { name, message, cause: cause?.name }
}

export type MeiliEngineResult<M, B> =
  { engine: 'meili'; value: M } | { engine: 'basic'; value: B }

// 引擎选择只在这里做, isMeiliEnabled() 也只在这里读 (kun/inv-search-01)。
// 只有 Meilisearch 自身的故障才换到 basic; 请求参数被拒抛 MeiliBadRequestError;
// 不是 Meilisearch 的异常 (回调里读 PG 的步骤失败、代码自己的错) 原样抛出, 不换引擎。
// 卡片水合放在调用之后: 两个引擎的返回值形状不同, 调用方按 engine 分支
export const withMeiliEngine = async <M, B>(
  meili: () => Promise<M>,
  basic: () => Promise<B>
): Promise<MeiliEngineResult<M, B>> => {
  if (!isMeiliEnabled()) {
    return { engine: 'basic', value: await basic() }
  }

  let value: M
  try {
    value = await meili()
  } catch (error) {
    const scope = classifyMeiliFailure(error)
    if (scope === null) {
      throw error
    }
    if (scope === 'request') {
      throw new MeiliBadRequestError(error)
    }

    if (scope === 'misconfigured') {
      // 降级让页面照常可用, 也让配置问题一直没人发现, 所以按 error 级别记
      // eslint-disable-next-line no-console
      console.error(
        '[kun-search] Meilisearch 索引与代码不一致 (检查 pnpm search:init 与密钥), 本次改用 basic 引擎:',
        summarize(error)
      )
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[kun-search] Meilisearch 不可用, 本次改用 basic 引擎:',
        summarize(error)
      )
    }
    return { engine: 'basic', value: await basic() }
  }

  return { engine: 'meili', value }
}
