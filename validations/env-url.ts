import * as z from 'zod'

// 不要用 z.string().url(): zod 4 底层是 WHATWG new URL(), 'localhost:3000' /
// 'www.moyu.moe:443' 这类 scheme-less 值会按 opaque scheme 解析而通过校验,
// 且 host 为空串, 下游 (middleware/_csrf.ts) 取 host 时会静默产生空 CSRF 白名单。
// 限定 http(s) 协议后 WHATWG 保证 host 非空。
export const kunWebUrlSchema = z.url({ protocol: /^https?$/ })

// 键缺失或显式留空 = 未配置: 下游 (middleware/_csrf.ts 的 getAllowedHosts 与各
// NODE_ENV 三元式消费点) 对 falsy 值全部安全跳过; 非空值仍走上面的完整校验,
// 不放开"填了但坏 → 静默空 CSRF 白名单"的口子。
export const kunOptionalWebUrlSchema = kunWebUrlSchema
  .or(z.literal(''))
  .optional()
