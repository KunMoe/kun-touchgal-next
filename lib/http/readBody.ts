import { KUN_PROXY_BODY_CLONE_LIMIT } from '~/constants/bodyBudget'
import { kunLog } from '~/lib/log.server'

// 读请求体的唯一出口 (T32): 边读边计数, 超过入口声明的预算就停, 不先把整段收进内存再判断。
// 预算取值在 constants/bodyBudget.ts。别处不直接调 req.json() / formData() / arrayBuffer() /
// text() / blob(), 也不读 req.body (kun/inv-body-01): 它们都要收完整段才返回, 不设上限。
// 纯模块, 不导入 prisma / redis / s3: OIDC 桥 (lib/oidc/webToNode.ts) 也用它

export type KunBodyFailure = {
  ok: false
  // too-large: Content-Length 声明的或已读到的字节超过预算。truncated: 读完了却比 Content-Length
  // 声明的少, 只在 proxy 克隆截断 (KUN_PROXY_BODY_CLONE_LIMIT) 之后出现; 没带 Content-Length 的
  // 截断从字节数上认不出来, 只能靠解析失败兜底。aborted: 读的过程中流出错
  reason: 'too-large' | 'truncated' | 'aborted'
  maxBytes: number
  received: number
  declared: number | null
}

export type KunBodyRead =
  { ok: true; bytes: Uint8Array<ArrayBuffer> } | KunBodyFailure

// 缺失、空串、不是十进制非负整数的都当没有声明 (null), 不能当成 0: Number(null) 与 Number('') 都是 0
export const parseContentLength = (header: string | null): number | null => {
  const value = header?.trim()
  return value && /^\d+$/.test(value) ? Number(value) : null
}

const pathOf = (req: Request) => {
  try {
    return new URL(req.url).pathname
  } catch {
    return String(req.url)
  }
}

export const kunReadBody = async (
  req: Request,
  maxBytes: number
): Promise<KunBodyRead> => {
  const declared = parseContentLength(req.headers.get('content-length'))
  const fail = (
    reason: KunBodyFailure['reason'],
    received: number
  ): KunBodyFailure => {
    // 每次拒绝记一行, 上线后据此发现误拒的入口、调大它的预算
    kunLog('body.rejected', {
      path: pathOf(req),
      reason,
      maxBytes,
      declared,
      received
    })
    return { ok: false, reason, maxBytes, received, declared }
  }

  if (declared !== null && declared > maxBytes) {
    return fail('too-large', 0)
  }
  if (!req.body) {
    return { ok: true, bytes: new Uint8Array(0) }
  }

  const chunks: Uint8Array[] = []
  let received = 0
  try {
    const reader = req.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      received += value.byteLength
      if (received > maxBytes) {
        // 剩下的不再接收; 取消本身出错也已经是失败, 不再区分
        await reader.cancel().catch(() => undefined)
        return fail('too-large', received)
      }
      chunks.push(value)
    }
  } catch {
    return fail('aborted', received)
  }
  if (declared !== null && received < declared) {
    return fail('truncated', received)
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}

const MIB = 1024 * 1024
const formatBytes = (bytes: number) =>
  bytes >= MIB
    ? `${Number((bytes / MIB).toFixed(1))} MB`
    : `${Math.ceil(bytes / 1024)} KB`

// 走 T | string 通道的入口回给用户的文案。超限可能由合法提交触发, 不能落进 schema 的兜底消息。
// 用它的都是 /api 的入口, 都在 proxy 之后, 收得下的不超过克隆上限: 超预算时按预算与克隆上限中
// 较小的说 (超出预算就一定超出较小者, 这句恒为真), 照着缩小就能过, 不会说出一个达不到的数
export const kunBodyFailureMessage = (failure: KunBodyFailure) => {
  switch (failure.reason) {
    case 'too-large':
      return `请求内容超过 ${formatBytes(Math.min(failure.maxBytes, KUN_PROXY_BODY_CLONE_LIMIT))}, 请缩小后重试`
    case 'truncated':
      return `请求内容超过 ${formatBytes(KUN_PROXY_BODY_CLONE_LIMIT)}, 请缩小后重试`
    case 'aborted':
      return '请求内容没有完整送达, 请重试'
  }
}

// 不走 T | string 通道的调用方 (OIDC 桥) 把失败抛给自己的入口, 由入口回真实的状态码
export class KunBodyLimitError extends Error {
  readonly failure: KunBodyFailure

  constructor(failure: KunBodyFailure) {
    super(`request body rejected: ${failure.reason}`)
    this.name = 'KunBodyLimitError'
    this.failure = failure
  }
}

// 与 Body.json() 相同的解码 (UTF-8, 去掉 BOM)。解析失败 (含空体) 一律是 null, 交给调用方的
// schema 拒绝 (parse-body-json-catch-null)
export const kunBodyJson = (bytes: Uint8Array<ArrayBuffer>): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
}

// multipart 与 urlencoded 表单。格式不对、没有 Content-Length 时被截断的 multipart (缺结尾的
// boundary) 都是 null, 不抛出
export const kunBodyFormData = (
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string | null
): Promise<FormData | null> =>
  new Response(
    bytes,
    contentType ? { headers: { 'content-type': contentType } } : undefined
  )
    .formData()
    .catch(() => null)
