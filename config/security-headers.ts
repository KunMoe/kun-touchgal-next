import type { KunHeaderRoute } from './rsc-cache-headers'

// 应用自己就能保证的响应安全头, 与边缘 (Cloudflare、nginx) 的分工见
// decision-making/7.edge-security-contract.md。next.config.ts 把它与 kunRscCacheHeaders 一起交给
// headers(), 所以这里只放与请求无关的静态头, 并守住四条:
// - 不写 Cache-Control: 游客 RSC 的缓存规则只归 rsc-cache-headers.ts (R2-C3)
// - 不写 CSP: proxy 的头盖过 headers(), headers() 又盖过 route handler 自设的同名头, oidc-provider
//   也只在响应里已有 CSP 时才给 form_post 的内联脚本追加哈希; 将来的 CSP 只能由 proxy 与 OIDC 桥设置
// - 不写 HSTS: 是整个域名的决定, 归边缘
// - 不写 COOP: 会切断依赖方用弹窗登录时依赖的 opener
// X-Frame-Options 取 DENY 而不是 SAMEORIGIN: 仓库里没有按 URL 嵌入本站页面的地方, srcdoc 文档不受它约束
export const kunSecurityHeaders: KunHeaderRoute[] = [
  {
    source: '/(.*)',
    headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()'
      }
    ]
  }
]
