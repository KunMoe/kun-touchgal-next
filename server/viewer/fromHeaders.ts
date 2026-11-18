import { cache } from 'react'
import { headers } from 'next/headers'
import { createViewerContext } from './context'

// page / layout / generateMetadata 以及它们调用的页面读取器用: 一次渲染内共用同一个上下文。
// React cache 只在渲染过程中去重, Route Handler 里每调一次都会新建上下文并重新校验会话,
// 那边用 fromRequest (kun/inv-viewer-01 执法)。
// 读的是请求带来的原始 Cookie 头 (与 Route Handler、proxy 同一个解码器), 不是 cookies():
// proxy 若在响应上写 cookie, cookies() 在同一次请求里看得到, 这里看不到。proxy 现在不写 cookie;
// 以后要在 proxy 里续签或清除 token, 得先处理这里
export const getViewerContext = cache(async () =>
  createViewerContext((await headers()).get('cookie') ?? '')
)
