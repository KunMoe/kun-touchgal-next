'use client'

import Link from 'next/link'

// 根布局自己渲染失败时的兜底: 它顶替根布局, 拿不到全局样式、HeroUI 与 Provider, 所以只用
// 行内样式与原生元素。错误编号对应服务端日志 request.unhandled 的 digest
export default function GlobalError({
  error,
  retry
}: {
  error: unknown
  retry: () => void
}) {
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error
      ? String(error.digest)
      : null

  return (
    <html lang="zh-Hans">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          colorScheme: 'light dark'
        }}
      >
        <title>出错了</title>
        <main style={{ maxWidth: '32rem', padding: '2rem' }}>
          <h1 style={{ fontSize: '1.5rem', margin: '0 0 0.5rem' }}>出错了</h1>
          <p style={{ margin: '0 0 1rem', opacity: 0.7 }}>
            页面没能加载出来, 请稍后重试。
          </p>
          {digest && (
            <p
              style={{
                margin: '0 0 1rem',
                fontFamily: 'monospace',
                fontSize: '0.75rem',
                opacity: 0.7,
                userSelect: 'all'
              }}
            >
              错误编号: {digest}
            </p>
          )}
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <button type="button" onClick={() => retry()}>
              重试
            </button>
            <Link href="/">返回首页</Link>
          </div>
        </main>
      </body>
    </html>
  )
}
