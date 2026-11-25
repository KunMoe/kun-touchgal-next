// 请求体的字节预算 (T32)。读请求体只经 lib/http/readBody.ts, 每个入口声明自己最多收多少字节:
// Route Handler 写在 kunRoute 的 maxBytes, 不写 input、自己读的入口直接传给 kunReadBody
const KIB = 1024
const MIB = 1024 * KIB

// 单张图片的上限: validations/file.ts 的文件 schema 与图片入口的整请求预算同取这一个数
export const KUN_IMAGE_MAX_BYTES = 10 * MIB

// 命中 proxy matcher (proxy.ts) 的非 GET / HEAD 请求, Next 在运行 proxy 之前把请求体缓冲下来,
// 超过这个数的部分直接丢弃 (截断, 不是拒绝): 这些入口实际收到的请求体不会超过它, 不论预算写多大。
// next.config.ts 的 experimental.proxyClientMaxBodySize 取它, 值与 Next 的默认值相同。不要为了收
// 更大的上传调大它: 克隆在鉴权与 CSRF 之前, 调大放大的是每个请求在鉴权之前占用的内存
export const KUN_PROXY_BODY_CLONE_LIMIT = 10 * MIB

export const KUN_BODY_BUDGET = {
  // 只收一两个短字段的入口: 上传的初始化与完成、撤销邮箱变更
  tiny: 16 * KIB,
  // JSON 入口不写 maxBytes 时的默认值, 与 Next 给 Server Actions 的默认 bodySizeLimit 相同
  json: MIB,
  // PUT /api/edit: schema 范围内合法的最坏载荷约 1.2 MiB (简介全是会被转义成 \u0001 的控制字符)
  jsonLarge: 2 * MIB,
  // OIDC 桥: 比 oidc-provider 自己的 56 KiB 上限略宽, 两者之间的请求仍交给 provider 报协议格式的错误
  oidc: 64 * KIB,
  // 一张图加几个表单字段的 multipart
  image: KUN_IMAGE_MAX_BYTES + 64 * KIB,
  // 封面加原图两张图的 multipart。这些入口仍在 proxy 之后, 实际上限是 KUN_PROXY_BODY_CLONE_LIMIT,
  // 超出的请求得到截断的文案
  imagePair: 2 * KUN_IMAGE_MAX_BYTES + MIB
} as const
