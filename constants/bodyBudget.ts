// 请求体的字节预算 (T32)。读请求体只经 lib/http/readBody.ts, 每个入口声明自己最多收多少字节:
// Route Handler 写在 kunRoute 的 maxBytes; 不写 input、在 handler 里自己解析的入口传给
// kunParsePostBody / kunParsePutBody 或 kunReadBody
const KIB = 1024
const MIB = 1024 * KIB

// 单张图片的上限: validations/file.ts 的文件 schema 与图片入口的整请求预算同取这一个数
export const KUN_IMAGE_MAX_BYTES = 10 * MIB

// 命中 proxy matcher (proxy.ts) 的非 GET / HEAD 请求, Next 为 proxy 克隆请求体, 并在交给 handler
// 之前收完整段 (proxy 返回什么都一样, CSRF 拒绝的 403 也要等上传收完), 超过这个数的部分读掉丢弃
// (截断, 不是拒绝): 这些入口实际收到的请求体不会超过它, 不论预算写多大; 原始字节在鉴权之前就已缓冲,
// 入口的预算省下的是之后的解析。next.config.ts 的 experimental.proxyClientMaxBodySize 取它, 值与
// Next 的默认值相同。不要为了收更大的上传调大它: 调大放大的是每个请求在鉴权之前占用的内存
export const KUN_PROXY_BODY_CLONE_LIMIT = 10 * MIB

export const KUN_BODY_BUDGET = {
  // 只收一两个短字段的入口: 上传的初始化与完成、撤销邮箱变更
  tiny: 16 * KIB,
  // JSON 入口不写 maxBytes 时的默认值, 与 Next 给 Server Actions 的默认 bodySizeLimit 相同
  json: MIB,
  // PUT /api/edit: 有上限的字段合起来最坏约 0.95 MiB (全部填会被转义成 \u0001 的控制字符),
  // 另有 7 个外部标签 / 会社数组没有条数上限, 所以单独放宽
  jsonLarge: 2 * MIB,
  // OIDC 桥: 比 oidc-provider 自己的 56 KiB 上限略宽, 两者之间的请求仍交给 provider 报协议格式的错误
  oidc: 64 * KIB,
  // 一张图加几个表单字段的 multipart
  image: KUN_IMAGE_MAX_BYTES + 64 * KIB,
  // 封面加原图两张图的 multipart。这些入口仍在 proxy 之后, 实际上限是 KUN_PROXY_BODY_CLONE_LIMIT,
  // 超出的请求一律回「请求内容超过 10 MB」(kunBodyFailureMessage 取两者中较小的)
  imagePair: 2 * KUN_IMAGE_MAX_BYTES + MIB
} as const
