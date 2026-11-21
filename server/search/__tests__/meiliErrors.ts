// 测试夹具 (不是测试文件): 与 meilisearch-js 抛出的错误同形的对象。
// 形状由 failure.test.ts 用真实 SDK + 桩掉的 fetch 钉住, 这里只供上层用例构造失败

// 没拿到应答: 连不上、超时
export const meiliDown = () =>
  Object.assign(new Error('Request to http://meili has failed'), {
    name: 'MeilisearchRequestError',
    cause: new DOMException('timed out', 'TimeoutError')
  })

// 没拿到应答: 拒连 (undici 把系统错误码挂在 TypeError 的 cause 上)
export const meiliRefused = () =>
  Object.assign(new Error('Request to http://meili has failed'), {
    name: 'MeilisearchRequestError',
    cause: new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
  })

// Meilisearch 以非 2xx 应答
export const meiliApiError = (status: number, code: string) =>
  Object.assign(new Error(`stub ${code}`), {
    name: 'MeilisearchApiError',
    response: { status },
    cause: { code }
  })
