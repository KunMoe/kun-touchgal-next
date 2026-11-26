type FetchOptions = {
  headers?: Record<string, string>
  query?: Record<string, string | number>
  body?: Record<string, unknown>
  formData?: FormData
}

// 失败只有一条通道: 断网、非 2xx、应答不是 JSON 都与业务失败 (200 + 字符串) 一样以字符串
// 返回, kunFetch 不抛异常, 调用方只写一条失败分支。
// 这里造出来的文案不能是合法 JSON: kunErrorHandler 先对字符串 JSON.parse, 抛异常才原样展示
export const KUN_FETCH_NETWORK_MESSAGE = '网络连接失败, 请检查网络后重试'
export const KUN_FETCH_PARSE_MESSAGE = '服务器返回了无法识别的内容, 请稍后重试'
// 非 2xx 一律以状态码结尾。响应体是 JSON 字符串时, 那是服务端给用户看的原因
// (CSRF 403、401、410), 放在前面
const kunFetchHttpMessage = (status: number, reason: string | null) => {
  const fallback = status >= 500 ? '服务暂时不可用, 请稍后重试' : '请求未能完成'
  return `${reason ?? fallback} (HTTP ${status})`
}
const KUN_FETCH_HTTP_MESSAGE = / \(HTTP \d{3}\)$/

// 请求没有得到 2xx 应答 (断网、非 2xx、应答不是 JSON), 也就是处理器没有给出结果。只给必须
// 分清这一点的站点用 (登出、2FA 临时令牌检查、输入过程中静默的自动搜索); 其余调用点把字符串
// 都当成同一种失败, 不要拿它分支。
// 返回 boolean 而不是类型谓词: 谓词的否定分支会把业务失败的字符串也排除掉, 让没收窄的值通过编译
export const isKunTransportFailure = (res: unknown): boolean =>
  typeof res === 'string' &&
  (res === KUN_FETCH_NETWORK_MESSAGE ||
    res === KUN_FETCH_PARSE_MESSAGE ||
    KUN_FETCH_HTTP_MESSAGE.test(res))

const reportKunFetchFailure = (detail: unknown) => {
  // eslint-disable-next-line no-console -- 客户端没有日志出口 (上报暂缓, T38 S5), 只留在浏览器控制台
  console.error(`Kun Fetch error: ${detail}`)
}

const readFailureReason = async (response: Response) => {
  try {
    const body: unknown = await response.json()
    return typeof body === 'string' && body.trim() ? body : null
  } catch {
    return null
  }
}

const kunFetchRequest = async <T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  options?: FetchOptions
): Promise<T | string> => {
  const { headers = {}, query, body, formData } = options || {}

  const queryString = query
    ? '?' +
      new URLSearchParams(
        Object.entries(query).map(([k, v]) => [k, String(v)])
      ).toString()
    : ''

  const fetchAddress =
    process.env.NODE_ENV === 'development'
      ? process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_DEV
      : process.env.NEXT_PUBLIC_KUN_PATCH_ADDRESS_PROD
  const fullUrl = `${fetchAddress}/api${url}${queryString}`

  const fetchOptions: RequestInit = {
    method,
    credentials: 'include',
    mode: 'cors',
    headers: {
      'X-Requested-With': 'kun-fetch',
      ...headers
    }
  }

  if (formData) {
    fetchOptions.body = formData
  } else if (body) {
    fetchOptions.body = JSON.stringify(body)
  }

  let response: Response
  try {
    response = await fetch(fullUrl, fetchOptions)
  } catch (error) {
    reportKunFetchFailure(error)
    return KUN_FETCH_NETWORK_MESSAGE
  }

  if (!response.ok) {
    reportKunFetchFailure(`Status: ${response.status}`)
    return kunFetchHttpMessage(
      response.status,
      await readFailureReason(response)
    )
  }

  try {
    return (await response.json()) as T | string
  } catch (error) {
    reportKunFetchFailure(error)
    return KUN_FETCH_PARSE_MESSAGE
  }
}

export const kunFetchGet = async <T>(
  url: string,
  query?: Record<string, string | number>
): Promise<T | string> => {
  return kunFetchRequest<T>(url, 'GET', { query })
}

export const kunFetchPost = async <T>(
  url: string,
  body?: Record<string, unknown>
): Promise<T | string> => {
  return kunFetchRequest<T>(url, 'POST', { body })
}

export const kunFetchPut = async <T>(
  url: string,
  body?: Record<string, unknown>
): Promise<T | string> => {
  return kunFetchRequest<T>(url, 'PUT', { body })
}

export const kunFetchDelete = async <T>(
  url: string,
  query?: Record<string, string | number>
): Promise<T | string> => {
  return kunFetchRequest<T>(url, 'DELETE', { query })
}

export const kunFetchFormData = async <T>(
  url: string,
  formData?: FormData
): Promise<T | string> => {
  // 漏传是调用方写错了, 不是运行时会遇到的失败
  if (!formData) {
    throw new Error('formData is required for kunFetchFormData')
  }
  return kunFetchRequest<T>(url, 'POST', { formData })
}
