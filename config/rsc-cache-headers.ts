import type { NextConfig } from 'next'

type KunHeaderRoute = Awaited<
  ReturnType<NonNullable<NextConfig['headers']>>
>[number]

// 动态页的 RSC 响应 (导航 / 预取) 默认带 no-store; 主文档同为 no-store 时, 页面内 JS
// 请求收到过 no-store 响应, Chrome 就不让整页进 bfcache, 跨文档后退一律整页重载
// (如 /redirect 离站再返回)。仅游客改为 private, no-cache: 登录态载荷含个人数据,
// 不落浏览器磁盘缓存; HTML 保持 no-store, Chrome 在 cookie 变化时仍会逐出页面。
// /doc 为静态预渲染, 保留 Next 默认的 s-maxage。
// next.config.ts 引入 dotenv-check 带副作用, 规则独立成模块供测试断言
export const kunRscCacheHeaders: KunHeaderRoute[] = [
  {
    source: '/((?!doc(?:/|$)).*)',
    has: [{ type: 'header', key: 'rsc', value: '1' }],
    missing: [{ type: 'cookie', key: 'kun-galgame-patch-moe-token' }],
    headers: [{ key: 'Cache-Control', value: 'private, no-cache' }]
  }
]
