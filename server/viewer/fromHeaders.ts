import { cache } from 'react'
import { headers } from 'next/headers'
import { createViewerContext } from './context'

// page / layout / generateMetadata 以及它们调用的页面读取器用: 一次渲染内共用同一个上下文。
// React cache 只在渲染过程中去重, Route Handler 里每调一次都会新建上下文并重新校验会话,
// 那边用 fromRequest (kun/inv-viewer-01 执法)
export const getViewerContext = cache(async () =>
  createViewerContext((await headers()).get('cookie') ?? '')
)
